import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { MoeErrorCode } from '../util/errors.js';
import { MATERIALIZE_LIMITS, materializeCommit, type MaterializedCommit, type MaterializeResult } from './commitMaterializer.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const scratch = (prefix: string) => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(dir); return dir; };
const listing = (dir: string) => fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).map(n => n.split(path.sep).join('/')).sort();
const none = { control: 0, unportable: 0, symlink: 0, submodule: 0 };
const posix = process.platform !== 'win32';

// A temp repository driven by a GIT_*-scrubbed git, so fixture writes can never reach a seat's own repository.
function repo() {
  const root = scratch('moe-mat-repo-'); const tmp = scratch('moe-mat-tmp-');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: posix ? '/dev/null' : 'NUL',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' });
  const raw = (args: string[], input?: string | Buffer) => execFileSync('git', args, { cwd: root, env, input });
  const git = (args: string[], input?: string | Buffer) => raw(args, input).toString('utf8').trim();
  git(['init', '-q']);
  const blob = (content: string) => git(['hash-object', '-w', '--no-filters', '--stdin'], content);
  // mktree builds trees straight from objects: no index, worktree, filter or path check (so '.GIT' is possible).
  const mktree = (...entries: (string | Buffer)[]) => git(['mktree', '-z'], Buffer.concat(entries.flatMap(e => [Buffer.from(e), Buffer.alloc(1)])));
  const commitOf = (...entries: (string | Buffer)[]) => git(['commit-tree', mktree(...entries), '-m', 'fixture']);
  const file = (name: string, content: string) => `100644 blob ${blob(content)}\t${name}`;
  const loose = (oid: string) => path.join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  return { root, tmp, raw, git, blob, mktree, commitOf, file, loose };
}
type Repo = ReturnType<typeof repo>;
async function ok(result: Promise<MaterializeResult>): Promise<MaterializedCommit> {
  const settled = await result;
  if (!settled.ok) throw new Error(`expected ok, got ${settled.reason}`);
  return settled.materialized;
}

// Committed a.ts and executable dir/b.ts, then a dirty a.ts, a staged dir/b.ts and an untracked c.ts.
function dirtyRepo() {
  const r = repo(); const put = (name: string, text: string) => fs.writeFileSync(path.join(r.root, name), text);
  fs.mkdirSync(path.join(r.root, 'dir')); put('a.ts', 'one\n'); put('dir/b.ts', '#!/bin/sh\necho b\n');
  r.git(['add', 'a.ts', 'dir/b.ts']); r.git(['update-index', '--chmod=+x', 'dir/b.ts']); r.git(['commit', '-q', '-m', 'c1']);
  const commit = r.git(['rev-parse', 'HEAD']);
  put('a.ts', 'dirty worktree\n'); put('dir/b.ts', 'staged\n'); r.git(['add', 'dir/b.ts']); put('c.ts', 'untracked\n');
  return { r, commit };
}

describe('materializeCommit', () => {
  it('M1 writes exactly the committed regular files with their bytes and exec bits, never dirty, staged or untracked bytes', async () => {
    const { r, commit } = dirtyRepo();
    const m = await ok(materializeCommit(r.root, commit, { tmpRoot: r.tmp }));
    const committed = ['a.ts', 'dir/b.ts'].map(name => r.raw(['cat-file', 'blob', `${commit}:${name}`]));
    expect([path.dirname(m.dir), path.basename(m.dir).startsWith('moe-materialize-')]).toEqual([r.tmp, true]);
    expect(listing(m.dir)).toEqual(['a.ts', 'dir', 'dir/b.ts']);
    expect([fs.readFileSync(path.join(m.dir, 'a.ts')), fs.readFileSync(path.join(m.dir, 'dir', 'b.ts'))]).toEqual(committed);
    expect({ commit: m.commit, tree: m.tree, files: m.files, bytes: m.bytes, skipped: m.skipped }).toEqual({ commit,
      tree: r.git(['rev-parse', `${commit}^{tree}`]), files: 2, bytes: committed[0].length + committed[1].length, skipped: none });
    expect(Object.isFrozen(m) && Object.isFrozen(m.skipped)).toBe(true);
    if (posix) {
      const mode = (name: string) => fs.statSync(path.join(m.dir, name)).mode;
      expect([mode('.') & 0o777, mode('dir/b.ts') & 0o100, mode('a.ts') & 0o111]).toEqual([0o700, 0o100, 0]);
    }
    await m.dispose();
  });

  it('M2 ignores smudge filters, eol conversion and attributes from the commit, worktree, info/attributes and local config', async () => {
    const r = repo(); const marker = path.join(scratch('moe-mat-mark-'), 'smudged').replace(/\\/g, '/');
    const attrs = '* filter=evil text eol=crlf\n'; const text = r.blob('l1\nl2\n');
    const commit = r.commitOf(r.file('.gitattributes', attrs), `100644 blob ${text}\tf.txt`);
    // Configured only after the commit exists, so no setup command runs the filter by accident.
    for (const [key, value] of [['filter.evil.smudge', `touch "${marker}"; cat`], ['filter.evil.clean', `touch "${marker}"; cat`],
      ['filter.evil.required', 'true'], ['core.autocrlf', 'true'], ['core.eol', 'crlf']]) r.git(['config', key, value]);
    fs.writeFileSync(path.join(r.root, '.gitattributes'), attrs);
    fs.mkdirSync(path.join(r.root, '.git', 'info'), { recursive: true }); fs.writeFileSync(path.join(r.root, '.git', 'info', 'attributes'), attrs);
    // Non-vacuous: git does run this filter when a read asks for worktree conversion.
    r.raw(['cat-file', '--filters', '--path=f.txt', text]); expect(fs.existsSync(marker)).toBe(true); fs.rmSync(marker);
    const m = await ok(materializeCommit(r.root, commit, { tmpRoot: r.tmp }));
    expect(fs.existsSync(marker)).toBe(false);
    expect([fs.readFileSync(path.join(m.dir, 'f.txt'), 'utf8'), fs.readFileSync(path.join(m.dir, '.gitattributes'), 'utf8')]).toEqual(['l1\nl2\n', attrs]);
  });

  it('M3 counts symlinks, gitlinks, control and unportable paths, and writes or links none of them', async () => {
    const r = repo(); const keep = r.blob('kept\n'); const inner = r.mktree(`100644 blob ${keep}\tx.json`);
    const commit = r.commitOf(`100644 blob ${keep}\tkeep.ts`, `120000 blob ${r.blob('keep.ts')}\tlnk`, `160000 commit ${'c'.repeat(40)}\tsub`,
      `040000 tree ${inner}\t.moe`, `040000 tree ${inner}\t.GIT`, `100644 blob ${keep}\tCON.txt`,
      Buffer.concat([Buffer.from(`100644 blob ${keep}\tbad`), Buffer.from([0xff]), Buffer.from('.ts')]));
    const m = await ok(materializeCommit(r.root, commit, { tmpRoot: r.tmp }));
    expect({ files: m.files, bytes: m.bytes, skipped: m.skipped }).toEqual({ files: 1, bytes: 5, skipped: { symlink: 1, submodule: 1, control: 2, unportable: 2 } });
    expect(listing(m.dir)).toEqual(['keep.ts']);
    expect(listing(m.dir).filter(name => !fs.lstatSync(path.join(m.dir, name)).isFile())).toEqual([]);
  });

  // b.ts's loose object keeps only its zlib header: ls-tree -l reads its size, but its bytes cannot be read.
  function unreadableBlob() {
    const r = repo(); const b = r.blob('bb'); const commit = r.commitOf(r.file('a.ts', 'aaaaa'), `100644 blob ${b}\tb.ts`);
    fs.chmodSync(r.loose(b), 0o644);
    fs.writeFileSync(r.loose(b), zlib.deflateSync(Buffer.from('blob 2\0'), { finishFlush: zlib.constants.Z_SYNC_FLUSH }));
    return { r, commit, b };
  }
  it.each([
    ['M4 files', { maxFiles: 1 }, 'limit-exceeded:files'],
    ['M5 bytes', { maxBytes: 6 }, 'limit-exceeded:bytes'],
    ['M6 an unreadable blob, after the directory exists', {}, 'git-failed:cat-file'],
  ])('%s: refuses before any blob read and leaves nothing under tmpRoot', async (_name, limits, reason) => {
    const { r, commit } = unreadableBlob();
    const result = await materializeCommit(r.root, commit, { limits, tmpRoot: r.tmp });
    expect(result.ok ? 'ok' : result.reason.split(': ')[0]).toBe(reason);
    expect(fs.readdirSync(r.tmp)).toEqual([]);
  });
  it('M6b a missing blob (ls-tree -l prints BAD, exit 0) is git-failed:ls-tree', async () => {
    const { r, commit, b } = unreadableBlob(); fs.rmSync(r.loose(b));
    expect(await materializeCommit(r.root, commit, { tmpRoot: r.tmp })).toEqual({ ok: false, reason: 'git-failed:ls-tree' });
  });

  it('M7 refuses a tmpRoot equal to or inside the project and creates nothing', async () => {
    const { r, commit } = dirtyRepo(); fs.mkdirSync(path.join(r.root, 'scratch'));
    const before = listing(r.root);
    for (const tmpRoot of [r.root, path.join(r.root, 'scratch')]) {
      expect(await materializeCommit(r.root, commit, { tmpRoot })).toEqual({ ok: false, reason: 'tmp-inside-project' });
    }
    expect(listing(r.root)).toEqual(before);
  });

  it('M8 leaves status, index, refs and every byte and mtime under projectRoot (including .git) unchanged', async () => {
    const { r, commit } = dirtyRepo(); r.git(['status']);
    const state = () => ({ status: r.raw(['--no-optional-locks', 'status', '--porcelain=v1', '-z']).toString('latin1'),
      refs: r.git(['for-each-ref']), files: listing(r.root).map(name => {
        const full = path.join(r.root, name); const stat = fs.lstatSync(full);
        return [name, stat.mode, stat.isFile() ? [stat.mtimeMs, createHash('sha256').update(fs.readFileSync(full)).digest('hex')] : null];
      }) });
    const before = state();
    expect(before.files.some(([name]) => name === '.git/index')).toBe(true);
    await (await ok(materializeCommit(r.root, commit, { tmpRoot: r.tmp }))).dispose();
    expect(state()).toEqual(before);
  });

  it('M9 dispose is idempotent and removes only its own directory', async () => {
    const { r, commit } = dirtyRepo(); fs.mkdirSync(path.join(r.tmp, 'sibling'));
    const m = await ok(materializeCommit(r.root, commit, { tmpRoot: r.tmp, limits: { timeBudgetMs: 60_000 } }));
    await m.dispose(); await m.dispose();
    expect([fs.existsSync(m.dir), fs.readdirSync(r.tmp)]).toEqual([false, ['sibling']]);
    // A later directory at the same path is not this materialization's to remove.
    fs.mkdirSync(m.dir); await m.dispose();
    expect(fs.existsSync(m.dir)).toBe(true);
  });

  it.each([
    ['commit HEAD', 'HEAD', {}, 'commit'], ['an uppercase commit', 'A'.repeat(40), {}, 'commit'],
    ['a 39-char commit', 'a'.repeat(39), {}, 'commit'], ['a 41-char commit', 'a'.repeat(41), {}, 'commit'],
    ['maxFiles 0', 'a'.repeat(40), { limits: { maxFiles: 0 } }, 'limits.maxFiles'],
    ['maxFiles 1.5', 'a'.repeat(40), { limits: { maxFiles: 1.5 } }, 'limits.maxFiles'],
    ['maxBytes over its ceiling', 'a'.repeat(40), { limits: { maxBytes: MATERIALIZE_LIMITS.maxBytes + 1 } }, 'limits.maxBytes'],
    ['timeBudgetMs 60001', 'a'.repeat(40), { limits: { timeBudgetMs: 60_001 } }, 'limits.timeBudgetMs'],
    ['an unknown limit', 'a'.repeat(40), { limits: { maxDepth: 1 } }, 'limits.maxDepth'],
    ['a relative tmpRoot', 'a'.repeat(40), { tmpRoot: 'relative/tmp' }, 'tmpRoot'],
  ])('M10 refuses %s with INVALID_INPUT before any IO', async (_name, commit, options, field) => {
    const tmp = scratch('moe-mat-tmp-');
    const call = materializeCommit(path.join(tmp, 'no-such-project'), commit, { tmpRoot: tmp, ...options } as never);
    await expect(call).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT, context: { field } });
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
  it('M10 refuses a relative projectRoot, which would resolve against the daemon cwd', async () => {
    await expect(materializeCommit('.', 'a'.repeat(40))).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT, context: { field: 'projectRoot' } });
  });

  it.each([
    ['case-folded twins', (r: Repo) => [r.file('A.ts', 'x'), r.file('a.ts', 'y')]],
    ['a file folding onto a directory', (r: Repo) => [r.file('A', 'x'), `040000 tree ${r.mktree(r.file('b', 'y'))}\ta`]],
    ['the same clash with a sibling sorting between them', (r: Repo) => [r.file('A', 'x'), r.file('a!x', 'z'), `040000 tree ${r.mktree(r.file('b', 'y'))}\ta`]],
  ])('M11 refuses %s as path-collision and leaves nothing under tmpRoot', async (_name, entries) => {
    const r = repo();
    expect(await materializeCommit(r.root, r.commitOf(...entries(r)), { tmpRoot: r.tmp })).toEqual({ ok: false, reason: 'path-collision' });
    expect(fs.readdirSync(r.tmp)).toEqual([]);
  });

  it('M12 refuses a tree, a blob, an annotated tag or an unknown id as commit-invalid, and a non-repository as repository', async () => {
    const r = repo(); const blob = r.blob('x'); const tree = r.mktree(`100644 blob ${blob}\tx`);
    r.git(['tag', '-a', 'v1', '-m', 'tag', r.git(['commit-tree', tree, '-m', 'c'])]);
    for (const id of [tree, blob, r.git(['rev-parse', 'v1']), 'd'.repeat(40)]) {
      const result = await materializeCommit(r.root, id, { tmpRoot: r.tmp });
      expect(result.ok ? 'ok' : result.reason.split(': ')[0]).toBe('commit-invalid');
    }
    const plain = scratch('moe-mat-plain-');
    const result = await materializeCommit(plain, 'a'.repeat(40), { tmpRoot: r.tmp });
    expect(result.ok ? 'ok' : result.reason.split(': ')[0]).toBe('repository');
    expect(fs.readdirSync(r.tmp)).toEqual([]);
  });

  // A fake git on PATH removes the blob just before cat-file runs, so cat-file prints '<oid> missing' and exits 0.
  it.skipIf(!posix)('M13 a blob that vanishes between listing and read fails the record check as git-failed:cat-file', async () => {
    const r = repo(); const b = r.blob('bb'); const commit = r.commitOf(r.file('a.ts', 'aaaaa'), `100644 blob ${b}\tb.ts`);
    const bin = scratch('moe-mat-bin-'); const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" cat-file "*) rm -f '${r.loose(b)}';; esac\nexec '${real}' "$@"\n`, { mode: 0o755 });
    const saved = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${saved}`;
    try {
      expect(await materializeCommit(r.root, commit, { tmpRoot: r.tmp })).toEqual({ ok: false, reason: 'git-failed:cat-file' });
    } finally { process.env.PATH = saved; }
    expect([fs.existsSync(r.loose(b)), fs.readdirSync(r.tmp)]).toEqual([false, []]);
  });
});
