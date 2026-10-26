import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedPlanRef, findCachedPlanPaths, type PlanPathGitRunner } from './cachedPlanPaths.js';

const commit = 'a'.repeat(40);
const blob = 'b'.repeat(40);
const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
const execFileMock = vi.hoisted(() => vi.fn());
const gitExecutableMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('./gitExecutable.js', () => ({ gitExecutable: gitExecutableMock }));
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-cached-path-'));
  gitExecutableMock.mockReturnValue(GIT);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); execFileMock.mockReset(); gitExecutableMock.mockReset();
  fs.rmSync(root, { recursive: true, force: true });
});

function runner(overrides: Partial<Record<'top' | 'config' | 'commit' | 'tree', string>> = {}) {
  return vi.fn<PlanPathGitRunner>(async args => {
    if (args[0] === 'config') return overrides.config ?? '';
    if (args.includes('--show-toplevel')) return overrides.top ?? root;
    if (args.includes('--verify')) return overrides.commit ?? commit;
    return overrides.tree ?? `100644 blob ${blob}\tsrc/existing.ts\0`;
  });
}

describe('cached plan source evidence', () => {
  it('trusts only the configured canonical project for a foreign-owned checkout', async () => {
    const canonical = fs.realpathSync(root);
    vi.stubEnv('GIT_DIR', '/foreign/repo');
    execFileMock.mockImplementation((_file, args, options, callback) => {
      if (!args.includes(`safe.directory=${canonical}`)) {
        callback(Object.assign(new Error('fatal: detected dubious ownership'), { code: 128 }));
        return;
      }
      expect(options.cwd).toBe(canonical);
      expect(options.env.GIT_DIR).toBeUndefined();
      expect(options.env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(options.env.GIT_CONFIG_GLOBAL).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null');
      expect(args.filter((arg: string) => arg.startsWith('safe.directory='))).toEqual([`safe.directory=${canonical}`]);
      const stdout = args.includes('--show-toplevel') ? canonical
        : args.includes('config') ? ''
        : args.includes('--verify') ? commit
        : `100644 blob ${blob}\tsrc/existing.ts\0`;
      // The mocked function has no execFile custom promisifier: return its result object.
      callback(null, { stdout, stderr: '' });
    });
    expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts'])).toMatchObject({
      commit, paths: ['src/existing.ts'],
    });
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it('does not turn a literal star directory into a Git subtree trust rule', async () => {
    const canonical = fs.realpathSync(root);
    vi.spyOn(fs.promises, 'realpath').mockResolvedValue(`${canonical}/*`);
    const run = runner();
    expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts'], run))
      .toEqual({ miss: expect.stringContaining('ends in /*') });
    expect(run).not.toHaveBeenCalled();
  });

  it('pins one ref and uses literal path arguments with a decreasing total budget', async () => {
    const run = runner();
    const result = await findCachedPlanPaths(root, 'release/main', ['src/existing.ts', 'typo.ts'], run);
    expect(result).toMatchObject({ ref: 'refs/remotes/origin/release/main', commit, paths: ['src/existing.ts'] });
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls[2][0]).toEqual(['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/release/main^{commit}']);
    const last = run.mock.calls[3][0];
    expect(last).toContain('--literal-pathspecs');
    expect(last.slice(-5)).toEqual(['--full-tree', commit, '--', 'src/existing.ts', 'typo.ts']);
    const budgets = run.mock.calls.map(call => call[2]);
    expect(budgets.every(t => t > 0 && t <= 2000)).toBe(true);
    expect(budgets).toEqual([...budgets].sort((a, b) => b - a));
  });

  it('uses ls-tree-supported literal arguments on Windows too', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const run = runner();
      await findCachedPlanPaths(root, 'main', ['src/existing.ts'], run);
      expect(run.mock.calls[3][0]).not.toContain('--icase-pathspecs');
      expect(run.mock.calls[3][0]).toContain('--literal-pathspecs');
    } finally { platform.mockRestore(); }
  });

  it.each([undefined, '', '*', 'feature/*', '../main', 'main.lock', 'main//x', 'main^{tree}', '-evil'])
    ('does not guess a source ref for %s', branch => { expect(cachedPlanRef(branch)).toBeUndefined(); });

  it('refuses a project nested inside a different repository', async () => {
    const run = runner({ top: path.dirname(root) });
    expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts'], run))
      .toEqual({ miss: expect.stringContaining('is not the project root') });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(['extensions.partialclone origin', 'remote.origin.promisor true', 'core.worktree /other'])
    ('refuses hydratable or redirected configuration %s', async config => {
      const run = runner({ config });
      expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts'], run))
        .toEqual({ miss: expect.stringContaining(`local Git config sets ${config.split(' ')[0]};`) });
      expect(run).toHaveBeenCalledTimes(2);
    });

  it.each(['timeout', 'ENOENT', 'output overflow', 'object absent'])('keeps uncertainty as missing: %s', async message => {
    const run = vi.fn<PlanPathGitRunner>().mockRejectedValue(new Error(message));
    expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts'], run)).toEqual({
      miss: expect.stringMatching(new RegExp(`^git rev-parse --show-toplevel: ${message} \\(\\d+ ms into the 2000 ms budget\\)$`)),
    });
  });

  it.each([
    ['a spawn failure', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', stdout: '', stderr: '' }),
      'ENOENT: spawn git ENOENT'],
    ['a timeout kill', Object.assign(new Error('Command failed: git rev-parse'), { killed: true, signal: 'SIGTERM', code: null, stderr: '' }),
      'killed (SIGTERM)'],
    ['a refused repository', Object.assign(new Error('Command failed: git rev-parse'), { code: 128,
      stderr: "fatal: detected dubious ownership in repository at '/repo'\n'/repo' is owned by:\n\tsomeone else\n" }),
      "128: fatal: detected dubious ownership in repository at '/repo'"],
  ])('names the failing Git step and %s in the miss', async (_kind, failure, detail) => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => { callback(failure); });
    const result = await findCachedPlanPaths(root, 'main', ['src/existing.ts']);
    expect(result).toEqual({ miss: expect.stringContaining(`git rev-parse --show-toplevel: ${detail} (`) });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['100644 blob bad\tsrc/existing.ts\0', 'unparsable ls-tree output for refs/remotes/origin/main'],
    [`100644 blob ${blob}\tsrc/existing.ts`, 'unparsable ls-tree output for refs/remotes/origin/main'],
    ['', `refs/remotes/origin/main at ${commit.slice(0, 12)} does not contain them either`],
  ])('refuses malformed or empty tree output %#', async (tree, miss) => {
    expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts'], runner({ tree }))).toEqual({ miss });
  });

  it('accepts an existing directory and a newline-containing literal filename', async () => {
    const files = ['src', 'a\nb.ts'];
    const run = runner({ tree: `040000 tree ${blob}\tsrc\0` + `100644 blob ${blob}\ta\nb.ts\0` });
    expect(await findCachedPlanPaths(root, 'main', files, run)).toMatchObject({ paths: files });
  });

  it.each([['../escape'], ['/absolute'], ['bad\0name'], Array(101).fill('src/x.ts')])
    ('refuses unsafe or excessive candidates before spawning Git', async (...args) => {
      const paths = args as string[];
      const run = runner();
      expect(await findCachedPlanPaths(root, 'main', paths, run))
        .toEqual({ miss: expect.stringMatching(/not in normalized project-relative form|lookup limit/) });
      expect(run).not.toHaveBeenCalled();
    });

  it('stops when the shared deadline expires instead of starting another process', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const run = vi.fn<PlanPathGitRunner>(async () => { now = 2001; return root; });
    expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts'], run)).toEqual({
      miss: 'git config --get-regexp: budget exhausted before the step started (2001 ms into the 2000 ms budget)',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('bounded raw Git reader', () => {
  const load = () => import('./cachedPlanPaths.js');
  it('returns successful output as raw bytes', async () => {
    const stdout = Buffer.from([0xff, 0, 65]);
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout }));
    expect(await (await load()).runGitHead(['cat-file'], root, 100, 8))
      .toEqual({ stdout, truncated: false, exitCode: 0, stderr: '' });
  });
  it('preserves exactly the bounded prefix on stdout overflow', async () => {
    const error = Object.assign(new Error('overflow'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: Buffer.from('abcdef'), killed: true,
    });
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(error));
    expect(await (await load()).runGitHead(['cat-file'], root, 100, 3))
      .toEqual({ stdout: Buffer.from('abc'), truncated: true, exitCode: null, stderr: '' });
  });
  it('resolves ordinary nonzero exits with bounded first-line stderr', async () => {
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(Object.assign(new Error('no match'), {
      code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('first\nsecond'),
    })));
    expect(await (await load()).runGitHead(['grep'], root, 100, 8))
      .toEqual({ stdout: Buffer.alloc(0), truncated: false, exitCode: 1, stderr: 'first' });
  });
  it.each([
    { code: 1, killed: true }, { code: 'ENOENT' }, { code: null, signal: 'SIGTERM' },
  ])('rethrows spawn, signal and timeout errors: %j', async fields => {
    const error = Object.assign(new Error('failed'), fields);
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(error));
    await expect((await load()).runGitHead(['grep'], root, 100, 8)).rejects.toBe(error);
  });
  it('shares runGit hardened argv and environment', async () => {
    vi.stubEnv('GIT_DIR', '/foreign');
    execFileMock.mockImplementation((_f, _a, options, cb) => cb(null, {
      stdout: options.encoding === 'buffer' ? Buffer.from('ok') : 'ok',
    }));
    const { runGit, runGitHead } = await load();
    await runGit(['cat-file'], root, 100, 7);
    await runGitHead(['cat-file'], root, 100, 7);
    const [ordinary, raw] = execFileMock.mock.calls;
    expect(raw.slice(0, 2)).toEqual(ordinary.slice(0, 2));
    expect(raw[1]).toEqual(['--no-optional-locks', '--no-replace-objects', '-c',
      'protocol.allow=never', '-c', `safe.directory=${root}`, 'cat-file']);
    expect(raw[2]).toEqual({ ...ordinary[2], encoding: 'buffer' });
    expect(raw[2]).toMatchObject({ windowsHide: true, maxBuffer: 7, env: {
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
    } });
    expect(raw[2].env.GIT_DIR).toBeUndefined();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid maxBytes %s before spawning', async maxBytes => {
    await expect((await load()).runGitHead([], root, 100, maxBytes)).rejects.toThrow('maxBytes');
    expect(execFileMock).not.toHaveBeenCalled();
  });
  it('uses the canonical root and shared deadline for head calls', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { openProjectGit } = await load();
    const head = vi.fn().mockResolvedValue({ stdout: Buffer.alloc(0), exitCode: 0, truncated: false, stderr: '' });
    const git = await openProjectGit(root, runner(), 100, head);
    now = 40;
    await git.head('cat-file', ['cat-file'], 8);
    expect(head).toHaveBeenCalledWith(['cat-file'], fs.realpathSync(root), 60, 8);
    now = 101;
    await expect(git.head('cat-file', ['cat-file'], 8)).rejects.toThrow('git cat-file: budget exhausted before the step started');
    expect(head).toHaveBeenCalledTimes(1);
  });
});

describe('daemon git spawns use the resolved absolute git', () => {
  const load = () => import('./cachedPlanPaths.js');
  it('spawns exactly the shared executable from runGit, runGitHead and diskState', async () => {
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: 'ok' }));
    const { runGit, runGitHead } = await load();
    const { defaultGitRunner } = await import('./diskState.js');
    await runGit(['cat-file'], root, 100);
    await runGitHead(['cat-file'], root, 100, 8);
    await defaultGitRunner(['status'], root);
    expect(execFileMock.mock.calls.map(call => call[0])).toEqual([GIT, GIT, GIT]);
    expect(execFileMock.mock.calls[2][1]).toEqual(['status']);
    expect(execFileMock.mock.calls[2][2]).not.toHaveProperty('env');
  });
  it('treats a resolution miss like a spawn ENOENT and never falls back to a bare git', async () => {
    const miss = Object.assign(new Error('git.com or git.exe not found in any fully qualified PATH entry'), { code: 'ENOENT' });
    gitExecutableMock.mockImplementation(() => { throw miss; });
    const { runGit, runGitHead } = await load();
    const { computeDiskStateSignature } = await import('./diskState.js');
    expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts']))
      .toEqual({ miss: expect.stringContaining('git rev-parse --show-toplevel: ENOENT: ') });
    expect(await computeDiskStateSignature(root)).toBeUndefined();
    await expect(runGitHead(['cat-file'], root, 100, 8)).rejects.toBe(miss);
    await expect(runGit(['cat-file'], root, 100)).rejects.toBe(miss);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
