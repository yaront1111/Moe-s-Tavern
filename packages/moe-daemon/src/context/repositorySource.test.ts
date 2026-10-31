import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoeErrorCode } from '../util/errors.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { GitHeadResult, PlanPathGitRunner } from '../util/cachedPlanPaths.js';
import * as source from './repositorySource.js';

const commit = 'a'.repeat(40);
const read = (path = 'src/a.ts', id = 'r') => ({ id, purpose: 'source' as const, op: 'read' as const, path });
const search = (paths?: string[]) => ({ id: 's', purpose: 'caller' as const, op: 'search' as const, literal: 'hello', paths });

describe('request validation', () => {
  const cases: [string, unknown, unknown, string][] = [
    ...['HEAD', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), '', null].map(c => ['commit', c, [read()], 'commit'] as [string, unknown, unknown, string]),
    ...[null, {}, [], Array.from({ length: 33 }, (_, i) => read('a', String(i)))].map(q => ['queries', commit, q, 'queries'] as [string, unknown, unknown, string]),
    ...[null, [], new Date()].map(q => ['plain object', commit, [q], 'queries[0]'] as [string, unknown, unknown, string]),
    ['op', commit, [{ ...read(), op: 'write' }], 'queries[0].op'],
    ['purpose', commit, [{ ...read(), purpose: 'other' }], 'queries[0].purpose'],
    ...['', 'x'.repeat(129), 1].map(id => ['id', commit, [{ ...read(), id }], 'queries[0].id'] as [string, unknown, unknown, string]),
    ['duplicate', commit, [read(), read()], 'queries[1].id'],
    ...['../x', 'a/../b', '/etc/passwd', 'C:/x', 'a\\b', './a', 'a//b', ' a', 'a ', 'a\0b', 'a\ufffd', 'a\u0001', 'a\u007f', 'a\u0085', 'a\u2028', 'a\u2029', 'a\ud800'].flatMap(path => [
      ['read path', commit, [read(path)], 'queries[0].path'],
      ['scope path', commit, [search([path])], 'queries[0].paths[0]'],
    ] as [string, unknown, unknown, string][]),
    ...['', 'x'.repeat(201), 'a\0b', 'a\rb', 'a\nb', 1].map(literal => ['literal', commit, [{ ...search(), literal }], 'queries[0].literal'] as [string, unknown, unknown, string]),
    ['scopes cap', commit, [search(Array(17).fill('a'))], 'queries[0].paths'],
    ['scopes shape', commit, [{ ...search(), paths: 'a' }], 'queries[0].paths'],
    ['pathspec budget includes ancestors', commit, Array.from({ length: 32 }, (_, i) => read(`${i}/${'deep/'.repeat(40)}a`, String(i))), 'pathspecs'],
  ];
  it.each(cases)('refuses %s %#', (_name, c, q, field) => {
    expect(() => source.validateSourceRequest(c, q)).toThrow(expect.objectContaining({
      code: MoeErrorCode.INVALID_INPUT, codeName: 'INVALID_INPUT', context: expect.objectContaining({ field }),
    }));
  });
  it('accepts valid immutable read and search requests', () => {
    expect(() => source.validateSourceRequest(commit, [read(), search(['src'])])).not.toThrow();
    expect(() => source.validateSourceRequest('b'.repeat(64), [search()])).not.toThrow();
  });
  it.each([0, -1, 1.5, 65537, NaN])('refuses invalid limit %s', maxFileBytes => {
    expect(() => source.validateSourceRequest(commit, [read()], { maxFileBytes })).toThrow(expect.objectContaining({
      code: MoeErrorCode.INVALID_INPUT, codeName: 'INVALID_INPUT', context: expect.objectContaining({ field: 'limits.maxFileBytes' }),
    }));
  });
  it('allows the explicit 10s time ceiling but not more', () => {
    expect(() => source.validateSourceRequest(commit, [read()], { timeBudgetMs: 10000 })).not.toThrow();
    expect(() => source.validateSourceRequest(commit, [read()], { timeBudgetMs: 10001 })).toThrow('limits.timeBudgetMs');
  });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
describe('source slots', () => {
  it('bounds five concurrent runners to two in FIFO order', async () => {
    const slots = new source.SourceSlots(2);
    const gates = Array.from({ length: 5 }, () => deferred());
    const order: number[] = [];
    let running = 0; let maximum = 0;
    const calls = gates.map((gate, i) => slots.run(1000, async () => {
      order.push(i); maximum = Math.max(maximum, ++running);
      await gate.promise; running--;
    }));
    await Promise.resolve(); expect(order).toEqual([0, 1]);
    for (let i = 0; i < 5; i++) { gates[i].resolve(); await calls[i]; }
    expect(order).toEqual([0, 1, 2, 3, 4]); expect(maximum).toBe(2);
  });
  it('removes timed-out waiters so the full capacity remains available', async () => {
    vi.useFakeTimers();
    const slots = new source.SourceSlots(2);
    const gate = deferred();
    const holders = [slots.run(100, () => gate.promise), slots.run(100, () => gate.promise)];
    const waiting = expect(slots.run(5, async () => 'dead')).rejects.toThrow('budget exhausted waiting for a git slot');
    await vi.advanceTimersByTimeAsync(6); await waiting;
    gate.resolve(); await Promise.all(holders);
    const nextGate = deferred(); let started = 0;
    const next = [0, 1].map(() => slots.run(10, async () => { started++; await nextGate.promise; }));
    await Promise.resolve(); expect(started).toBe(2);
    nextGate.resolve(); await Promise.all(next);
  });
  it('releases when the runner throws', async () => {
    const slots = new source.SourceSlots(1);
    await expect(slots.run(50, async () => { throw new Error('runner'); })).rejects.toThrow('runner');
    expect(await slots.run(50, async () => 'free')).toBe('free');
  });
  it.each(['run', 'head'] as const)('passes the reduced timeout through limited %s', async kind => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const slots = new source.SourceSlots(1); const gate = deferred();
    const holder = slots.run(100, () => gate.promise);
    const run = vi.fn().mockResolvedValue(kind === 'run' ? '' : { stdout: Buffer.alloc(0), truncated: false, exitCode: 0, stderr: '' });
    const limited = kind === 'run' ? source.limitedRun(slots, run) : source.limitedHead(slots, run);
    const pending = limited([], '/root', 100, 8);
    now = 40; gate.resolve(); await holder; await pending;
    expect(run).toHaveBeenCalledWith([], '/root', 60, 8);
  });
  it('does not start a runner when queueing consumed the entire deadline', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const slots = new source.SourceSlots(1); const gate = deferred();
    const holder = slots.run(100, () => gate.promise); const run = vi.fn();
    const pending = source.limitedHead(slots, run)([], '/root', 100, 8);
    now = 100; gate.resolve(); await holder;
    await expect(pending).rejects.toThrow('budget exhausted waiting for a git slot');
    expect(run).not.toHaveBeenCalled();
  });
});

const roots: string[] = [];
async function removeRoot(root: string) {
  // Windows can retain a child's cwd briefly; retry transient holds, not persistent failures.
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
async function removeRoots(recorded: string[]) {
  const results = await Promise.allSettled(recorded.map(removeRoot));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Failed to remove repository source fixtures');
}

async function withHeldRoot(exercise: (root: string, release: () => void, closed: Promise<number | null>) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-source-held-')); roots.push(root);
  const child = spawn(process.execPath, ['-e', `
    process.stdin.once('data', () => setTimeout(() => process.exit(0), 250));
    process.stdout.write('ready\\n');
    process.stdin.resume();
  `], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, killSignal: 'SIGKILL' });
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('cwd holder readiness deadline')), 3000);
      child.once('error', reject); child.stdin.once('error', reject);
      child.once('close', () => reject(new Error('cwd holder exited before readiness')));
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; if (output === 'ready\n') resolve(); });
    });
    clearTimeout(timer);
    await exercise(root, () => child.stdin.end('release'), closed);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await closed;
    await removeRoot(root);
  }
}

describe.skipIf(process.platform !== 'win32')('fixture cleanup: native Windows cwd holds (Windows-only lock semantics)', () => {
  it('removes a root after a bounded transient hold ends', async () => {
    await withHeldRoot(async (root, release, closed) => {
      release();
      await removeRoot(root);
      expect(await closed).toBe(0);
      expect(fs.existsSync(root)).toBe(false);
    });
  });
  it('rejects a hold beyond the retry budget instead of hiding it', async () => {
    await withHeldRoot(async root => {
      await expect(removeRoot(root)).rejects.toMatchObject({ code: expect.stringMatching(/^(EPERM|EBUSY)$/) });
      expect(fs.existsSync(root)).toBe(true);
    });
  });
  it('closes its child and removes the root when an assertion fails', async () => {
    const failure = new Error('exercise failed'); let held = '';
    await expect(withHeldRoot(async root => { held = root; throw failure; })).rejects.toBe(failure);
    expect(fs.existsSync(held)).toBe(false);
  });
});

describe('fixture cleanup', () => {
  it('removes every root and accepts already removed roots', async () => {
    const recorded = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'moe-source-')));
    roots.push(...recorded);
    await removeRoots(recorded); await removeRoots(recorded);
    expect(recorded.map(root => fs.existsSync(root))).toEqual([false, false]);
  });
  it('attempts every root before surfacing persistent and unexpected errors', async () => {
    const held = Object.assign(new Error('held'), { code: 'EPERM' }); const unexpected = new Error('unexpected');
    const later = deferred();
    const rm = vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(held)
      .mockImplementationOnce(() => later.promise).mockRejectedValueOnce(unexpected);
    const pending = expect(removeRoots(['held', 'later', 'unexpected'])).rejects.toMatchObject({ errors: [held, unexpected] });
    expect(rm.mock.calls).toEqual(['held', 'later', 'unexpected'].map(root =>
      [root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }]));
    later.resolve(); await pending;
  });
});

afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  await removeRoots(roots.splice(0));
});
function fixture(files: Record<string, string | Buffer> = { 'src/a.ts': 'hello\n' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-source-')); roots.push(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' });
  const git = (args: string[], input?: string | Buffer) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env, input }).trim();
  git(['init', '-q']); env.GIT_INDEX_FILE = path.join(root, '.git', 'fixture-index');
  const put = (name: string, contents: string | Buffer, mode = '100644') => {
    const oid = git(['hash-object', '-w', '--no-filters', '--stdin'], contents);
    git(['update-index', '--add', '--cacheinfo', `${mode},${oid},${name}`]); return oid;
  };
  const link = (name: string, oid: string) => git(['update-index', '--add', '--cacheinfo', `160000,${oid},${name}`]);
  const save = () => {
    const tree = git(['write-tree']); const commit = git(['commit-tree', tree, '-m', 'fixture']);
    git(['update-ref', 'refs/heads/fixture', commit]); return { commit, tree };
  };
  const oids = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, put(name, content)]));
  return { root, git, put, save, link, oids, ...save() };
}
const options = { limits: { timeBudgetMs: 10000 } };
const raw = (text: string): GitHeadResult => ({ stdout: Buffer.from(text), truncated: false, exitCode: 0, stderr: '' });
function fakeRun(root: string, listing = `100644 blob ${'b'.repeat(40)}       6\tsrc/a.ts\0`) {
  return vi.fn<PlanPathGitRunner>(async args => args.includes('--show-toplevel') ? fs.realpathSync(root)
    : args[0] === 'config' ? '' : args.includes('--verify') ? commit : listing);
}

describe('immutable repository reads', () => {
  it('serves exact bytes and metadata for regular and executable blobs', async () => {
    const f = fixture(); const oid = f.put('run', 'execute', '100755'); const c = f.save().commit;
    const result = await source.readRepositorySource(f.root, c, [read(), read('run', 'x')], options);
    expect(result).toEqual({ manifest: { commit: c }, items: [
      { ...read(), status: 'served', oid: f.oids['src/a.ts'], mode: '100644', size: 6, content: 'hello\n', bytes: 6 },
      { ...read('run', 'x'), status: 'served', oid, mode: '100755', size: 7, content: 'execute', bytes: 7 },
    ], complete: true, limitations: ['committed-bytes-only'], bytes: 13 });
  });
  it('preserves missing and served siblings in query order', async () => {
    const f = fixture();
    const result = await source.readRepositorySource(f.root, f.commit, [read('missing'), read('src/a.ts', 'ok')], options);
    expect(result.items.map(i => [i.id, i.status, i.reason, i.content])).toEqual([
      ['r', 'missing', 'not-in-manifest', undefined], ['ok', 'served', undefined, 'hello\n'],
    ]); expect(result.complete).toBe(false);
  });
  it.each([
    ['lnk', 'symlink'], ['lnk/x.ts', 'symlink-ancestor'], ['sub', 'submodule'], ['sub/x.ts', 'submodule'],
    ['src', 'not-a-file'], ['src/a.ts/x', 'not-in-manifest'],
  ])('classifies %s without following links', async (p, reason) => {
    const f = fixture(); f.put('lnk', '/outside', '120000'); f.link('sub', f.commit);
    const result = await source.readRepositorySource(f.root, f.save().commit, [read(p), read('src/a.ts', 'sibling')], options);
    expect(result.items[0]).toMatchObject({ status: reason === 'not-in-manifest' ? 'missing' : 'refused', reason, bytes: 0 });
    expect(result.items[0]).not.toHaveProperty('content'); expect(result.items[1].content).toBe('hello\n');
  });
  it.each([['binary', Buffer.from('a\0b')], ['not-utf8', Buffer.from([0xe9])]] as const)('refuses %s', async (reason, content) => {
    const f = fixture({ a: content });
    expect((await source.readRepositorySource(f.root, f.commit, [read('a')], options)).items[0])
      .toMatchObject({ status: 'refused', reason, bytes: 0, size: content.length });
  });
  it('truncates a multibyte character at the byte cap without replacement characters', async () => {
    const f = fixture({ a: 'abc😀tail' });
    expect((await source.readRepositorySource(f.root, f.commit, [read('a')], { limits: { ...options.limits, maxFileBytes: 5 } })).items[0])
      .toMatchObject({ status: 'truncated', reason: 'file-byte-cap', content: 'abc', bytes: 3, size: 11 });
  });
  it('reads only the requested commit despite later commits and dirty worktree bytes', async () => {
    const f = fixture(); f.put('src/a.ts', 'new'); f.save();
    fs.mkdirSync(path.join(f.root, 'src')); fs.writeFileSync(path.join(f.root, 'src/a.ts'), 'dirty');
    expect((await source.readRepositorySource(f.root, f.commit, [read()], options)).items[0].content).toBe('hello\n');
  });
  it('refuses a nested project toplevel', async () => {
    const f = fixture(); const nested = path.join(f.root, 'nested'); fs.mkdirSync(nested);
    expect((await source.readRepositorySource(nested, f.commit, [read()], options)).items[0])
      .toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/^repository: .*not the project root/) });
  });
  it.each(['unknown', 'tree'] as const)('refuses %s manifest', async kind => {
    const f = fixture();
    expect((await source.readRepositorySource(f.root, kind === 'tree' ? f.tree : commit, [read()], options)).items[0])
      .toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/^manifest:/) });
  });
  it('refuses invalid requests without filesystem access or runner calls', async () => {
    const run = vi.fn(); const realpath = vi.spyOn(fs.promises, 'realpath');
    await expect(source.readRepositorySource('/absent', 'HEAD', [read()], { run })).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });
    expect(run).not.toHaveBeenCalled(); expect(realpath).not.toHaveBeenCalled();
  });
  it('does not start queued items after the shared deadline', async () => {
    const f = fixture(); let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const head = vi.fn(async () => { now = 101; return raw('hello\n'); });
    const result = await source.readRepositorySource(f.root, commit, [read(), read('src/a.ts', 'second')], {
      run: fakeRun(f.root), head, slots: new source.SourceSlots(1), limits: { timeBudgetMs: 100 },
    });
    expect(result.items[0].status).toBe('served');
    expect(result.items[1]).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('budget exhausted') });
    expect(head).toHaveBeenCalledTimes(1);
  });
  it('refuses a blob whose returned size disagrees with the manifest', async () => {
    const f = fixture();
    const result = await source.readRepositorySource(f.root, commit, [read()], { run: fakeRun(f.root), head: async () => raw('short') });
    expect(result.items[0]).toMatchObject({ status: 'unavailable', reason: 'size-mismatch', bytes: 0 });
  });
  it.each(['garbage\0', `100644 blob ${'b'.repeat(40)}       6\tsrc/a.ts`])('refuses malformed listing %#', async listing => {
    const f = fixture(); const head = vi.fn();
    const result = await source.readRepositorySource(f.root, commit, [read()], { run: fakeRun(f.root, listing), head });
    expect(result.items[0]).toMatchObject({ status: 'unavailable', reason: 'git ls-tree: unparsable output' });
    expect(head).not.toHaveBeenCalled();
  });
  it('keeps a cat-file failure local to its item', async () => {
    const f = fixture(); const head = vi.fn().mockResolvedValueOnce({ ...raw(''), exitCode: 128, stderr: 'absent' }).mockResolvedValueOnce(raw('hello\n'));
    const result = await source.readRepositorySource(f.root, commit, [read(), read('src/a.ts', 'ok')], { run: fakeRun(f.root), head });
    expect(result.items.map(i => [i.status, i.reason])).toEqual([['unavailable', 'git cat-file: absent'], ['served', undefined]]);
  });
});

describe('literal searches and aggregate bounds', () => {
  it('pins match output when local grep.column is enabled', async () => {
    const f = fixture({ 'src/a.ts': 'first\n  hello\n' });
    f.git(['config', '--local', 'grep.column', 'true']);
    const result = await source.readRepositorySource(f.root, f.commit, [search()], options);
    expect(result.items[0]).toEqual({ id: 's', purpose: 'caller', op: 'search', status: 'served',
      matches: [{ path: 'src/a.ts', line: 2, text: '  hello' }], bytes: Buffer.byteLength('src/a.ts  hello') });
    expect(result.complete).toBe(true);
  });
  it('never serves matches from a populated submodule when local submodule.recurse is enabled', async () => {
    const f = fixture(); const child = (args: string[], input?: string) => f.git(['-C', 'src/sub', ...args], input);
    f.git(['init', '-q', 'src/sub']); const blob = child(['hash-object', '-w', '--no-filters', '--stdin'], 'hello from SUBMODULE\n');
    f.link('src/sub', child(['commit-tree', child(['mktree'], `100644 blob ${blob}\ts.txt\n`), '-m', 'child']));
    const gitmodules = '[submodule "sub"]\n\tpath = src/sub\n\turl = ./src/sub\n';
    f.put('.gitmodules', gitmodules); fs.writeFileSync(path.join(f.root, '.gitmodules'), gitmodules);
    f.git(['config', 'submodule.sub.active', 'true']); f.git(['config', 'submodule.recurse', 'true']);
    const c = f.save().commit;
    expect(f.git(['grep', '-l', '-F', '-e', 'hello', c]).split('\n')).toEqual([`${c}:src/a.ts`, `${c}:src/sub/s.txt`]);
    const result = await source.readRepositorySource(f.root, c, [{ ...search(), id: 'all' }, { ...search(['src']), id: 'dir' },
      { ...search(['src/sub']), id: 'link' }, read('src/sub/s.txt')], options);
    const parent = [{ path: 'src/a.ts', line: 1, text: 'hello' }];
    expect(result.items.map(i => [i.id, i.status, i.reason, i.matches])).toEqual([['all', 'served', undefined, parent],
      ['dir', 'served', undefined, parent], ['link', 'refused', 'submodule', undefined], ['r', 'refused', 'submodule', undefined]]);
  });
  it('serves committed text matches despite an untracked -diff attribute', async () => {
    const f = fixture({ 'a.ts': 'first\nhello\n' });
    fs.writeFileSync(path.join(f.root, '.gitattributes'), 'a.ts -diff\n');
    expect(f.git(['check-attr', 'diff', '--', 'a.ts'])).toBe('a.ts: diff: unset');
    expect(f.git(['ls-tree', '--name-only', f.commit])).toBe('a.ts');
    const result = await source.readRepositorySource(f.root, f.commit, [search(['a.ts'])], options);
    expect(result.items[0]).toEqual({ id: 's', purpose: 'caller', op: 'search', status: 'served',
      matches: [{ path: 'a.ts', line: 2, text: 'hello' }], bytes: Buffer.byteLength('a.tshello') });
    expect(result.complete).toBe(true);
  });
  it('reports a NUL-containing binary match line explicitly instead of an empty success', async () => {
    const f = fixture({ 'b.bin': Buffer.from('bin\0hello\n') });
    const result = await source.readRepositorySource(f.root, f.commit, [search()], options);
    expect(result.items[0]).toEqual({ id: 's', purpose: 'caller', op: 'search', status: 'truncated',
      reason: 'undecodable-match', matches: [], bytes: 0 });
    expect(result.complete).toBe(false);
  });
  it('serves exact committed matches with spaces, lines, and literal-only limitations', async () => {
    const f = fixture({ 'dir/a space.ts': 'first\nhello world\n', 'other': 'no' });
    const result = await source.readRepositorySource(f.root, f.commit, [search()], options);
    expect(result.items[0]).toEqual({ id: 's', purpose: 'caller', op: 'search', status: 'served',
      matches: [{ path: 'dir/a space.ts', line: 2, text: 'hello world' }], bytes: Buffer.byteLength('dir/a space.tshello world') });
    expect(result.limitations).toEqual(['committed-bytes-only', 'literal-search-only']);
    expect(result.complete).toBe(true);
  });
  it('serves a true negative as an empty match list', async () => {
    const f = fixture({ a: 'absent' });
    expect((await source.readRepositorySource(f.root, f.commit, [search()], options)).items[0])
      .toMatchObject({ status: 'served', matches: [], bytes: 0 });
  });
  it.each([['missing', 'missing', 'scope-not-in-manifest'], ['lnk', 'refused', 'symlink'], ['sub/x', 'refused', 'submodule']])
    ('never reports empty success for scope %s', async (scope, status, reason) => {
      const f = fixture(); f.put('lnk', 'hello', '120000'); f.link('sub', f.commit);
      const result = await source.readRepositorySource(f.root, f.save().commit, [search([scope])], options);
      expect(result.items[0]).toMatchObject({ status, reason, bytes: 0 });
      expect(result.items[0]).not.toHaveProperty('matches'); expect(result.limitations).toEqual(['committed-bytes-only']);
    });
  it.each(['src', 'src/a.ts'])('accepts %s as a search scope', async scope => {
    const f = fixture();
    expect((await source.readRepositorySource(f.root, f.commit, [search([scope])], options)).items[0].matches)
      .toEqual([{ path: 'src/a.ts', line: 1, text: 'hello' }]);
  });
  it('only keeps complete records at the search byte cap', async () => {
    const f = fixture({ a: 'hello\nhello again\n' });
    const cap = Buffer.byteLength(`${f.commit}:a\0` + '1\0hello\n') + 3;
    const result = await source.readRepositorySource(f.root, f.commit, [search()], { limits: { ...options.limits, maxSearchBytes: cap } });
    expect(result.items[0]).toMatchObject({ status: 'truncated', reason: 'search-byte-cap', matches: [{ path: 'a', line: 1, text: 'hello' }] });
  });
  it('keeps only the first match at the match cap', async () => {
    const f = fixture({ a: 'hello\nhello again\n' });
    expect((await source.readRepositorySource(f.root, f.commit, [search()], { limits: { ...options.limits, maxMatches: 1 } })).items[0])
      .toMatchObject({ status: 'truncated', reason: 'match-cap', matches: [{ path: 'a', line: 1, text: 'hello' }] });
  });
  it('does not search symlink target text', async () => {
    const f = fixture({ a: 'no' }); f.put('lnk', 'hello', '120000');
    expect((await source.readRepositorySource(f.root, f.save().commit, [search()], options)).items[0])
      .toMatchObject({ status: 'served', matches: [] });
  });
  it('omits overflowing items in query order and removes their payloads', async () => {
    const f = fixture();
    const result = await source.readRepositorySource(f.root, f.commit, [read(), read('src/a.ts', 'later'), search()], { limits: { ...options.limits, maxTotalBytes: 6 } });
    expect(result.items.map(i => [i.status, i.reason, i.bytes])).toEqual([
      ['served', undefined, 6], ['omitted', 'total-byte-cap', 0], ['omitted', 'total-byte-cap', 0],
    ]); expect(result.bytes).toBe(6); expect(result.complete).toBe(false);
    expect(result.items[1]).not.toHaveProperty('content'); expect(result.items[2]).not.toHaveProperty('matches');
  });
  it('applies the total byte cap in query order, not completion order', async () => {
    const f = fixture(); const gates = [deferred<GitHeadResult>(), deferred<GitHeadResult>()];
    const entered = deferred(); let count = 0;
    const head = vi.fn(() => { const gate = gates[count++]; if (count === 2) entered.resolve(); return gate.promise; });
    const pending = source.readRepositorySource(f.root, commit, [read(), read('src/a.ts', 'later')], {
      run: fakeRun(f.root), head, limits: { maxTotalBytes: 6 },
    });
    await entered.promise; gates[1].resolve(raw('hello\n')); await Promise.resolve(); gates[0].resolve(raw('hello\n'));
    const reverse = await pending;
    const natural = await source.readRepositorySource(f.root, commit, [read(), read('src/a.ts', 'later')], {
      run: fakeRun(f.root), head: async () => raw('hello\n'), limits: { maxTotalBytes: 6 },
    });
    expect(reverse).toEqual(natural); expect(reverse.items.map(i => i.status)).toEqual(['served', 'omitted']);
  });
  it.each([
    Buffer.from(`wrong:a\0` + '1\0hello\n'), Buffer.from(`${commit}:../x\0` + '1\0hello\n'),
    Buffer.from(`${commit}:a\0` + '0\0hello\n'), Buffer.from(`${commit}:a\0` + 'oops\0hello\n'),
    Buffer.concat([Buffer.from(`${commit}:a\0` + '1\0hello'), Buffer.from([255, 10])]),
    Buffer.from(`${commit}:a\0` + '1\0unterminated'),
    Buffer.from(`${commit}:a\0` + '1\0' + '3\0  hello\n'),
  ])('marks undecodable or unrepresentable records explicitly %#', async stdout => {
    const f = fixture();
    const result = await source.readRepositorySource(f.root, commit, [search()], { run: fakeRun(f.root), head: async () => ({ ...raw(''), stdout }) });
    expect(result.items[0]).toMatchObject({ status: 'truncated', reason: 'undecodable-match', matches: [] });
  });
  it('does not interpret literal or pathspec metacharacters as options', async () => {
    const f = fixture({ 'literal[1].ts': '-hello\n', 'literal1.ts': '-hello\n', 'else': 'hello' });
    const result = await source.readRepositorySource(f.root, f.commit, [{ ...search(['literal[1].ts']), literal: '-hello' }], options);
    expect(result.items[0]).toMatchObject({ status: 'served', matches: [{ path: 'literal[1].ts', line: 1, text: '-hello' }] });
    expect(result.items[0].matches).toHaveLength(1);
  });
  it('does not turn grep failure into an empty success', async () => {
    const f = fixture();
    const result = await source.readRepositorySource(f.root, commit, [search()], {
      run: fakeRun(f.root), head: async () => ({ ...raw(''), exitCode: 128, stderr: 'broken' }),
    });
    expect(result.items[0]).toMatchObject({ status: 'unavailable', reason: 'git grep: broken' });
    expect(result.items[0]).not.toHaveProperty('matches');
  });
});

describe('adversarial boundary regressions', () => {
  it.each([[new Array(1), 'queries[0]'], [[{ ...search(), paths: new Array(1) }], 'queries[0].paths[0]']])
    ('rejects sparse arrays before processing %#', (queries, field) => {
      expect(() => source.validateSourceRequest(commit, queries)).toThrow(expect.objectContaining({
        code: MoeErrorCode.INVALID_INPUT, codeName: 'INVALID_INPUT', context: expect.objectContaining({ field }),
      }));
    });
  it('does not decode high-bit bytes as ASCII decimal line numbers', async () => {
    const f = fixture();
    const stdout = Buffer.concat([Buffer.from(`${commit}:a\0`), Buffer.from([0xb1]), Buffer.from('\0hello\n')]);
    const result = await source.readRepositorySource(f.root, commit, [search()], { run: fakeRun(f.root), head: async () => ({ ...raw(''), stdout }) });
    expect(result.items[0]).toMatchObject({ status: 'truncated', reason: 'undecodable-match', matches: [] });
  });
  it('detaches validated queries from caller mutations during Git setup', async () => {
    const f = fixture(); const started = deferred(); const release = deferred(); const normalRun = fakeRun(f.root);
    const run: PlanPathGitRunner = async (...args) => { started.resolve(); await release.promise; return normalRun(...args); };
    const queries = [read()];
    const pending = source.readRepositorySource(f.root, commit, queries, { run, head: async () => raw('hello\n') });
    await started.promise; queries[0].path = '../outside'; queries[0].id = 'changed'; release.resolve();
    expect((await pending).items[0]).toMatchObject({ id: 'r', path: 'src/a.ts', status: 'served', content: 'hello\n' });
    expect(normalRun.mock.calls.at(-1)?.[0]).not.toContain('../outside');
  });
  it('preserves a UTF-8 BOM as source bytes', async () => {
    const f = fixture({ a: '\ufeffhello' });
    expect((await source.readRepositorySource(f.root, f.commit, [read('a')], options)).items[0])
      .toMatchObject({ status: 'served', content: '\ufeffhello', bytes: 8, size: 8 });
  });
  it.each(['ENOENT', 'killed', 'budget exhausted'])('keeps thrown search failure %s explicit', async message => {
    const f = fixture();
    const result = await source.readRepositorySource(f.root, commit, [search()], { run: fakeRun(f.root), head: async () => { throw new Error(message); } });
    expect(result.items[0]).toMatchObject({ status: 'unavailable', reason: expect.stringContaining(message) });
    expect(result.items[0]).not.toHaveProperty('matches');
  });
  it.each(['extensions.partialclone origin', 'remote.origin.promisor true', 'core.worktree /elsewhere'])('refuses repository setting %s', async config => {
    const f = fixture(); const normal = fakeRun(f.root); const head = vi.fn();
    const run: PlanPathGitRunner = (...args) => args[0][0] === 'config' ? Promise.resolve(config) : normal(...args);
    const result = await source.readRepositorySource(f.root, commit, [read()], { run, head });
    expect(result.items[0]).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/^repository: local Git config sets/) });
    expect(result.limitations).toEqual(['committed-bytes-only', 'repository-unavailable']); expect(head).not.toHaveBeenCalled();
  });
});


it('names a regular-file ancestor of a scope as not-in-manifest', async () => {
  const f = fixture();
  const result = await source.readRepositorySource(f.root, f.commit, [search(['src/a.ts/child'])], options);
  expect(result.items[0]).toMatchObject({ status: 'missing', reason: 'not-in-manifest' });
});
