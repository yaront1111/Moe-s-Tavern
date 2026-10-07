import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedPlanRef, findCachedPlanPaths, type PlanPathGitRunner } from './cachedPlanPaths.js';

const commit = 'a'.repeat(40);
const blob = 'b'.repeat(40);
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-cached-path-')); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); execFileMock.mockReset(); fs.rmSync(root, { recursive: true, force: true }); });

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
    expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts'], run)).toBeUndefined();
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
    expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts'], run)).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(['extensions.partialclone origin', 'remote.origin.promisor true', 'core.worktree /other'])
    ('refuses hydratable or redirected configuration %s', async config => {
      const run = runner({ config });
      expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts'], run)).toBeUndefined();
      expect(run).toHaveBeenCalledTimes(2);
    });

  it.each(['timeout', 'ENOENT', 'output overflow', 'object absent'])('keeps uncertainty as missing: %s', async message => {
    const run = vi.fn<PlanPathGitRunner>().mockRejectedValue(new Error(message));
    expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts'], run)).toBeUndefined();
  });

  it.each(['100644 blob bad\tsrc/existing.ts\0', `100644 blob ${blob}\tsrc/existing.ts`, ''])
    ('refuses malformed or empty tree output', async tree => {
      expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts'], runner({ tree }))).toBeUndefined();
    });

  it('accepts an existing directory and a newline-containing literal filename', async () => {
    const files = ['src', 'a\nb.ts'];
    const run = runner({ tree: `040000 tree ${blob}\tsrc\0` + `100644 blob ${blob}\ta\nb.ts\0` });
    expect((await findCachedPlanPaths(root, 'main', files, run))?.paths).toEqual(files);
  });

  it.each([['../escape'], ['/absolute'], ['bad\0name'], Array(101).fill('src/x.ts')])
    ('refuses unsafe or excessive candidates before spawning Git', async (...args) => {
      const paths = args as string[];
      const run = runner();
      expect(await findCachedPlanPaths(root, 'main', paths, run)).toBeUndefined();
      expect(run).not.toHaveBeenCalled();
    });

  it('stops when the shared deadline expires instead of starting another process', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const run = vi.fn<PlanPathGitRunner>(async () => { now = 2001; return root; });
    expect(await findCachedPlanPaths(root, 'main', ['src/existing.ts'], run)).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
