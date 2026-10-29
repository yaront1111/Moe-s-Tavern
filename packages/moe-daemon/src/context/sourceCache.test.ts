import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGit, runGitHead } from '../util/cachedPlanPaths.js';
import { MoeErrorCode } from '../util/errors.js';
import { readRepositorySource, type SourceOptions, type SourceQuery } from './repositorySource.js';
import type { AnalyzerCallResult, AnalyzerTool } from './mcpStdioClient.js';
import { readSemanticSource, type SemanticOptions, type SemanticQuery } from './semanticSource.js';
import { readSnapshotSource, type SnapshotRequest } from './snapshotSource.js';
import { cachedRepositorySource, cachedSemanticSource, cachedSnapshotSource, isPositiveAnswer, isPositiveSource, SourceCache, sourceCacheKey } from './sourceCache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Snapshot fixtures come from the landed R09a/R09b producers, absent in the Docker context (packages/moe-daemon only).
const runner = path.resolve(here, '../../../../scripts/local-runner');
const hasScripts = fs.existsSync(path.join(runner, 'source-snapshot.mjs'));
const load = async (name: string) => (hasScripts ? import(pathToFileURL(path.join(runner, name)).href) : null);
const [r09a, r09b] = [await load('source-snapshot.mjs'), await load('source-export.mjs')];
const json = (value: unknown) => JSON.stringify(value);
const dirs: string[] = [];
const scratch = (prefix: string) => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
const read = (name: string, id = `r:${name}`): SourceQuery => ({ id, purpose: 'source', op: 'read', path: name });
const search = (literal: string, paths?: string[]): SourceQuery => ({ id: `s:${literal}:${paths ?? ''}`, purpose: 'caller', op: 'search', literal, ...(paths ? { paths } : {}) });
// A temp repository driven by a GIT_*-scrubbed git; commit() writes the files and commits them.
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.test' };
function repo() {
  const root = scratch('moe-cache-repo-'), git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8' }).trim();
  const put = (files: Record<string, string>) => { for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); } };
  git('init', '-q');
  return { root, git, put, commit: (files: Record<string, string>) => { put(files); git('add', '-A'); git('commit', '-q', '-m', 'c'); return git('rev-parse', 'HEAD'); } };
}

describe('C1-C8 SourceCache core', () => {
  it('C1 stores and returns independent copies', () => {
    const c = new SourceCache(), value = { a: [1] }; c.set('k', value); value.a.push(2);
    const got = c.get<{ a: number[] }>('k')!; got.a.push(3);
    expect([got === value, c.get('k')]).toEqual([false, { a: [1] }]);
  });
  it('C2 evicts the least recently used entry', () => {
    const c = new SourceCache({ maxEntries: 2 }); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
    expect([c.get('a'), c.get('b'), c.get('c'), c.stats().evictions]).toEqual([1, undefined, 3, 1]);
  });
  it('C2b accepts custom maxEntries and maxBytes together', () => {
    const c = new SourceCache({ maxEntries: 1, maxBytes: 10 }); c.set('a', 'x'); c.set('b', 'y');
    expect([c.get('a'), c.get('b')]).toEqual([undefined, 'y']);
    c.set('c', 'x'.repeat(20));
    expect([c.get('c'), c.get('b')]).toEqual([undefined, 'y']);
  });
  it('C3 holds at most maxBytes, the sum of stored sizes, and never an oversize or unclonable value', () => {
    const c = new SourceCache({ maxBytes: 10 }); c.set('a', 'xx'); c.set('a', 'x'.repeat(20));
    expect(c.get('a')).toBeUndefined();
    for (const [key, value] of [['a', 'xxx'], ['b', 'yyy'], ['c', 1n], ['d', () => 1]] as const) c.set(key, value);
    expect(c.stats()).toMatchObject({ entries: 2, bytes: 10 }); c.set('e', 'z');
    expect([c.get('a'), c.get('b'), c.stats()]).toEqual([undefined, 'yyy', { entries: 2, bytes: 8, hits: 1, misses: 2, evictions: 1 }]);
  });
  it('C4 clear() and a new instance (a restart) miss everything', () => {
    const c = new SourceCache(); c.set('a', 1); c.clear();
    expect([c.get('a'), new SourceCache().get('a'), c.stats()]).toEqual([undefined, undefined, { entries: 0, bytes: 0, hits: 0, misses: 1, evictions: 0 }]);
  });
  it.each([{ maxEntries: 0 }, { maxBytes: -1 }, { maxEntries: 1.5 }, { maxEntries: '2' }, { maxBytes: NaN }, { other: 1 }, new Date(), [], null])('C5 refuses limits %o', limits => {
    expect(() => new SourceCache(limits as never)).toThrow(expect.objectContaining({ code: MoeErrorCode.INVALID_INPUT }));
  });
  it('C6 keys are sha256 hex, equal only for equal parts', () => {
    const key = sourceCacheKey(['a', { b: [1, 2] }]); expect([key, sourceCacheKey(['a', { b: [1, 2] }])]).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), key]);
    for (const other of [['b', { b: [1, 2] }], ['a', { b: [2, 1] }], ['a', { c: [1, 2] }], ['a', { b: [1, 2] }, null]]) expect(sourceCacheKey(other)).not.toBe(key);
  });
  it('C7 only served reads, matching searches and complete nonblank answers are positive', () => {
    const items = [{ status: 'served', op: 'read', content: '' }, { status: 'served', op: 'search', matches: [{}] }, { status: 'served', op: 'search', matches: [] },
      ...['truncated', 'omitted', 'missing', 'refused', 'unavailable'].map(status => ({ status, op: 'read' }))];
    expect(items.map(isPositiveSource)).toEqual([true, true, false, false, false, false, false, false]);
    expect(['x', '[1]', '', '  ', '[]', ' [ ] ', '{ }', '\n{}\n'].map(text => isPositiveAnswer({ ok: true, text, truncated: false }))).toEqual([true, true, false, false, false, false, false, false]);
    expect([isPositiveAnswer({ ok: true, text: 'x', truncated: true }), isPositiveAnswer({ ok: false, reason: 'tool-error' })]).toEqual([false, false]);
  });
  it('C8 the cache module imports no filesystem or process module', () => {
    const text = fs.readFileSync(path.join(here, 'sourceCache.ts'), 'utf8');
    expect([...text.matchAll(/from '([^']+)'/g)].map(m => m[1]).filter(m => /^(?:node:)?(?:fs|fs\/promises|child_process)$/.test(m))).toEqual([]);
    expect(text).not.toMatch(/\bimport\(|\brequire\(/);
  });
});

describe('G1-G5 cachedRepositorySource over real Git', () => {
  let root = '', c1 = '', c2 = '';
  beforeAll(() => {
    const r = repo(); root = r.root; c1 = r.commit({ 'src/a.ts': 'export const helper = 1\n', 'src/b.ts': 'export const b = 2\n' }); c2 = r.commit({ 'src/a.ts': 'export const helper = 2\n' });
  });
  const BATCH = [read('src/a.ts'), search('helper'), read('src/nope.ts'), search('zzz')];
  const cmd = (args: string[]) => args.find(a => !a.startsWith('-'))!;
  it('G1 uncached, warm, restarted and constantly evicting caches answer identically', async () => {
    const warm = new SourceCache(), tiny = new SourceCache({ maxEntries: 1 });
    const renamed = BATCH.map(q => ({ ...q, id: `x${q.id}`, purpose: 'pattern' as const }));
    for (const batch of [BATCH, renamed]) {
      const cold = json(await readRepositorySource(root, c1, batch));
      for (const c of [warm, warm, new SourceCache(), tiny, tiny]) expect(json(await cachedRepositorySource(c, root, c1, batch))).toBe(cold);
    }
    expect([warm.stats().hits, tiny.stats().evictions > 0]).toEqual([6, true]);
  });
  it('G2 hits skip their Git work; an all-positive warm batch runs no Git', async () => {
    const c = new SourceCache(), log: string[] = [];
    const spied: SourceOptions = { run: (args, ...rest) => (log.push(cmd(args)), runGit(args, ...rest)), head: (args, ...rest) => (log.push(cmd(args)), runGitHead(args, ...rest)) };
    await cachedRepositorySource(c, root, c1, BATCH, spied);
    log.length = 0; await cachedRepositorySource(c, root, c1, BATCH, spied);
    expect(log.filter(x => x === 'cat-file' || x === 'grep')).toEqual(['grep']);
    log.length = 0; await cachedRepositorySource(c, root, c1, BATCH.slice(0, 2), spied);
    expect(log).toEqual([]);
  });
  it('G3 a failing subset answers with the uncached batch, never a cached item', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const c = new SourceCache(), batch = [read('src/a.ts'), read('src/b.ts')]; await cachedRepositorySource(c, root, c1, batch.slice(0, 1));
    const failing: SourceOptions = { run: (args, ...rest) => (args.includes('--show-toplevel') ? Promise.reject(new Error('boom')) : runGit(args, ...rest)) };
    const warm = await cachedRepositorySource(c, root, c1, batch, failing);
    expect(json(warm)).toBe(json(await readRepositorySource(root, c1, batch, failing)));
    expect([warm.items.map(i => i.status), warm.limitations]).toEqual([['unavailable', 'unavailable'], ['committed-bytes-only', 'repository-unavailable']]);
  });
  it('G4 refuses a traversal as C02 does, before any Git', async () => {
    const log: string[] = [], opts: SourceOptions = { run: (args, ...rest) => (log.push(cmd(args)), runGit(args, ...rest)) };
    const refusal = expect.objectContaining({ code: MoeErrorCode.INVALID_INPUT, context: expect.objectContaining({ field: 'queries[0].path' }) });
    await expect(readRepositorySource(root, c1, [read('../x')])).rejects.toThrow(refusal);
    await expect(cachedRepositorySource(new SourceCache(), root, c1, [read('../x')], opts)).rejects.toThrow(refusal);
    expect(log).toEqual([]);
  });
  it('G5 a new commit is new content; the old commit keeps its bytes', async () => {
    const c = new SourceCache();
    for (const commit of [c1, c2, c1, c2]) expect(json(await cachedRepositorySource(c, root, commit, [read('src/a.ts')]))).toBe(json(await readRepositorySource(root, commit, [read('src/a.ts')])));
    expect(c.stats()).toMatchObject({ hits: 2, misses: 2 });
  });
});

describe.skipIf(!hasScripts)('S1-S6 cachedSnapshotSource over R09-sealed snapshots', () => {
  const COMMIT = 'c'.repeat(40), TREE = 'd'.repeat(40);
  const file = (name: string, text: string) => ({ kind: 'file', path: name, executable: false, data: Uint8Array.from(Buffer.from(text)) });
  const snap = (base: unknown[], overlay: unknown[] = []) => ({ version: 1, commit: COMMIT, tree: TREE, base: r09a.validateImport(base), overlay: r09a.validateImport(overlay), excluded: 0 });
  type Snap = ReturnType<typeof snap>;
  // Every warm answer is compared with the uncached one, key order included.
  const both = (c: SourceCache, s: unknown, qs: SourceQuery[], request: SnapshotRequest = { commit: COMMIT }, limits = {}) => {
    const warm = json(cachedSnapshotSource(c, s, request, qs, { limits })); expect(warm).toBe(json(readSnapshotSource(s, request, qs, { limits })));
    return JSON.parse(warm) as ReturnType<typeof readSnapshotSource>;
  };
  const hitsOf = (c: SourceCache, run: () => unknown) => { const before = c.stats().hits; run(); return c.stats().hits - before; };
  const shown = (r: ReturnType<typeof readSnapshotSource>) => r.items.map(i => i.content ?? i.matches?.length);
  const BASE = [file('docs/x.md', 'x\n'), file('package-lock.json', '{"helper": 1}\n'), file('src/a.ts', 'helper a\n'), file('src/util.ts', 'helper util\n')];
  const lock = (text: string) => snap(BASE, [file('package-lock.json', text)]);
  it('S1 a dirty edit with unchanged porcelain status is new content (real Git, real R09b export)', async () => {
    const r = repo(); const commit = r.commit({ 'src/a.ts': 'alpha0\n', 'src/b.ts': 'b\n' });
    const take = async (text: string): Promise<[string, Snap]> => { r.put({ 'src/a.ts': text }); return [r.git('status', '--porcelain=v1'), await r09b.exportSourceSnapshot({ repoDir: r.root, commit })]; };
    const [[p1, s1], [p2, s2]] = [await take('alpha1\n'), await take('bravo2\n')];
    expect([p1, p1 === p2, s1.overlay.digest === s2.overlay.digest]).toEqual(['M src/a.ts', true, false]);
    const c = new SourceCache(), q = [read('src/a.ts'), read('src/b.ts'), search('alpha1')];
    const at = (s: Snap) => both(c, s, q, { commit, base: s.base.digest, overlay: s.overlay.digest });
    expect(shown(at(s1))).toEqual(['alpha1\n', 'b\n', 1]);
    let second; expect(hitsOf(c, () => { second = at(s2); })).toBe(1);
    expect(shown(second!)).toEqual(['bravo2\n', 'b\n', 0]);
  });
  it('S2 a lockfile edit misses only the slices that read it', () => {
    const c = new SourceCache(), q = [read('src/a.ts'), read('package-lock.json'), search('helper', ['src']), search('helper')]; both(c, lock('{\n"helper": 2}\n'), q);
    expect(q.map(x => hitsOf(c, () => both(c, lock('{\n\n"helper": 3}\n'), [x])))).toEqual([1, 0, 1, 0]);
  });
  it('S3 a hit restamps provenance from the snapshot served', () => {
    const c = new SourceCache(), q = [read('src/a.ts'), search('same')]; both(c, snap([file('src/a.ts', 'same\n')]), q);
    const moved = snap([file('src/a.ts', 'old\n')], [file('src/a.ts', 'same\n')]);
    let r; expect(hitsOf(c, () => { r = both(c, moved, q); })).toBe(2);
    expect([r!.items[0].provenance, r!.items[1].matches![0].provenance]).toEqual(Array(2).fill({ layer: 'overlay', manifest: moved.overlay.digest, sha256: expect.any(String) }));
  });
  it('S4 deleted, unverifiable and stale snapshots are never served from the cache', () => {
    const files = [file('src/a.ts', 'a\n'), file('src/b.ts', 'b\n')], good = snap(files), c = new SourceCache(), q = [read('src/a.ts'), read('src/b.ts')];
    both(c, good, q); const { entries } = c.stats();
    const corrupt = { ...good, base: { ...good.base, entries: [{ ...good.base.entries[0], sha256: '0'.repeat(64) }, good.base.entries[1]] } };
    const cases: [unknown, SnapshotRequest, string][] = [[snap(files, [{ kind: 'delete', path: 'src/a.ts' }]), { commit: COMMIT }, 'deleted-in-overlay'],
      [corrupt, { commit: COMMIT }, 'snapshot-unverifiable:SNAPSHOT_HASH_MISMATCH'], [good, { commit: COMMIT, base: 'f'.repeat(64) }, 'snapshot-stale']];
    for (const [s, request, reason] of cases) expect(both(c, s, q, request).items[0].reason).toBe(reason);
    expect(c.stats().entries).toBe(entries);
  });
  it('S5 shared, fresh and constantly evicting caches answer as uncached, total cap included', () => {
    const shared = new SourceCache(), tiny = new SourceCache({ maxEntries: 1 }), q = [read('src/a.ts'), read('package-lock.json'), search('helper'), search('same', ['src'])];
    for (const s of [lock('1 helper\n'), lock('2 helper\n'), lock('1 helper\n'), snap([file('src/a.ts', 'same\n')])]) for (const c of [shared, new SourceCache(), tiny]) both(c, s, q);
    const big = snap([file('a.txt', 'a'.repeat(600)), file('c.txt', 'c'.repeat(500)), file('x.txt', 'x'.repeat(500))]), c = new SourceCache();
    both(c, big, [read('c.txt')], undefined, { maxTotalBytes: 1000 });
    expect(both(c, big, [read('c.txt'), read('a.txt'), read('x.txt')], undefined, { maxTotalBytes: 1000 }).items.map(i => i.status)).toEqual(['served', 'omitted', 'served']);
  });
  it('S6 raw input that reads differently twice never mixes two snapshots', () => {
    const A = snap([file('src/a.ts', 'A\n'), file('src/b.ts', 'b\n')]), B = snap([file('src/a.ts', 'B\n'), file('src/b.ts', 'b\n')]);
    const c = new SourceCache(), q = [read('src/b.ts'), read('src/a.ts')]; both(c, A, [read('src/b.ts')]); let reads = 0;
    const tricky = { version: 1, commit: COMMIT, tree: TREE, get base() { reads += 1; return reads === 2 ? B.base : A.base; }, overlay: A.overlay, excluded: 0 };
    expect([json(cachedSnapshotSource(c, tricky, { commit: COMMIT }, q)), reads]).toEqual([json(readSnapshotSource(A, { commit: COMMIT }, q)), 3]);
  });
});

describe('M1-M4 cachedSemanticSource through C03 seams', () => {
  const C1 = 'c'.repeat(40), C2 = 'e'.repeat(40);
  const props = (...keys: string[]) => ({ type: 'object', properties: Object.fromEntries(keys.map(key => [key, { type: 'string' }])) });
  const TOOLS: AnalyzerTool[] = [{ name: 'find_symbol', inputSchema: props('name_path_pattern', 'relative_path') },
    { name: 'find_referencing_symbols', inputSchema: props('name_path', 'relative_path') }, { name: 'get_symbols_overview', inputSchema: props('relative_path') }];
  const MQ: SemanticQuery[] = [{ id: 's', purpose: 'source', op: 'symbol', name: 'helper' }, { id: 'o', purpose: 'source', op: 'overview', path: 'src/a.ts' }];
  beforeEach(() => { const home = scratch('moe-cache-home-'); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('SERENA_HOME', ''); });
  interface Over { version?: string; tools?: AnalyzerTool[]; answer?: AnalyzerCallResult; openFails?: boolean; serenaPath?: string }
  const log = { calls: 0 };
  const seams = (over: Over = {}): SemanticOptions => ({
    serenaPath: over.serenaPath ?? process.execPath,
    materialize: async (_root, commit) => ({ ok: true, materialized: { dir: scratch('moe-cache-mat-'), commit, tree: commit, files: 0, bytes: 0,
      skipped: { control: 0, unportable: 0, symlink: 0, submodule: 0 }, dispose: async () => {} } }),
    fallback: async (_root, commit, qs) => ({ manifest: { commit }, items: qs.map(q => ({ id: q.id, purpose: q.purpose, op: q.op, status: 'missing', bytes: 0 })),
      complete: false, limitations: ['committed-bytes-only'], bytes: 0 }),
    open: async () => (over.openFails ? { ok: false, reason: 'spawn-failed' } : { ok: true, session: {
      server: { name: 'serena', version: over.version ?? '1.6.2', protocolVersion: '2025-06-18' }, tools: over.tools ?? TOOLS, close: async () => {},
      call: async (tool, args) => { log.calls++; return over.answer ?? { ok: true, text: `${tool}:${JSON.stringify(args)}`, truncated: false }; } } }),
  });
  // Tool calls the cached run made; its answer must equal the uncached one over the same seams.
  const calls = async (c: SourceCache, options: SemanticOptions, commit = C1) => {
    const before = log.calls, warm = json(await cachedSemanticSource(c, '/repo', commit, MQ, options)), made = log.calls - before;
    expect(warm).toBe(json(await readSemanticSource('/repo', commit, MQ, options))); return made;
  };
  it('M1 a warm call makes no tool calls; a fresh cache answers the same', async () => {
    const c = new SourceCache(), s = seams();
    expect([await calls(c, s), await calls(c, s), await calls(new SourceCache(), s)]).toEqual([2, 0, 2]);
  });
  it('M2-M3 a new commit, analyzer version, command or tool schema misses; restoring the identity hits', async () => {
    const c = new SourceCache(), exe = path.join(scratch('moe-cache-exe-'), 'serena');
    fs.writeFileSync(exe, ''); fs.chmodSync(exe, 0o755); await calls(c, seams());
    const wider = [{ ...TOOLS[0], inputSchema: props('name_path_pattern', 'relative_path', 'depth') }, ...TOOLS.slice(1)];
    expect([await calls(c, seams(), C2), await calls(c, seams({ version: '1.6.3' })), await calls(c, seams({ serenaPath: exe })),
      await calls(c, seams({ tools: wider })), await calls(c, seams())]).toEqual([2, 2, 2, 1, 0]);
  });
  it.each([['empty', { ok: true, text: ' [ ] ', truncated: false }], ['truncated', { ok: true, text: 'x', truncated: true }],
    ['failed', { ok: false, reason: 'tool-error' }]] as const)('M4 a %s answer is never stored', async (_name, answer) => {
    const c = new SourceCache(), s = seams({ answer });
    expect([await calls(c, s), await calls(c, s), c.stats().entries]).toEqual([2, 2, 0]);
  });
  it('M4 a failed open serves C03 unavailable items and leaves the cache untouched', async () => {
    const c = new SourceCache(); await calls(c, seams({ openFails: true }));
    expect(c.stats()).toEqual({ entries: 0, bytes: 0, hits: 0, misses: 0, evictions: 0 });
  });
});
