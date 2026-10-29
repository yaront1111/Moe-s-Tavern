import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openProjectGit } from './cachedPlanPaths.js';

// Real Git, real default runner: the mocked suite cannot see which config
// scopes `git config` actually reads.
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function tmp(prefix: string) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
function fixture() {
  const root = fs.realpathSync(tmp('moe-cfg-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  git('commit', '-q', '--allow-empty', '-m', 'fixture');
  return { root, git };
}

describe('openProjectGit config refusal against real Git', () => {
  it('resolves a plain repository and runs Git through the returned runner', async () => {
    const { root } = fixture();
    const git = await openProjectGit(root);
    expect((await git('rev-parse --show-toplevel', ['rev-parse', '--show-toplevel'])).trim()).toBe(root);
  });

  it('refuses a promisor key set in config.worktree', async () => {
    const { root, git } = fixture();
    git('config', 'extensions.worktreeConfig', 'true'); git('config', '--worktree', 'remote.o.promisor', 'true');
    await expect(openProjectGit(root)).rejects.toThrow('remote.o.promisor');
  });

  it('refuses core.worktree set in config.worktree', async () => {
    const { root, git } = fixture();
    git('config', 'extensions.worktreeConfig', 'true'); git('config', '--worktree', 'core.worktree', root);
    await expect(openProjectGit(root)).rejects.toThrow('core.worktree');
  });

  it('refuses a promisor key reached through an include.path in config.worktree', async () => {
    const { root, git } = fixture();
    const inc = path.join(tmp('moe-inc-'), 'inc.cfg'); fs.writeFileSync(inc, '[remote "o"]\n\tpromisor = true\n');
    git('config', 'extensions.worktreeConfig', 'true'); git('config', '--worktree', 'include.path', inc);
    await expect(openProjectGit(root)).rejects.toThrow('remote.o.promisor');
  });

  it('ignores config.worktree when extensions.worktreeConfig is off, as Git does', async () => {
    const { root, git } = fixture();
    fs.writeFileSync(path.join(root, '.git', 'config.worktree'), '[remote "o"]\n\tpromisor = true\n');
    await expect(openProjectGit(root)).resolves.toBeTypeOf('function');
  });

  it('does not newly read global config: a HOME .gitconfig with the key is masked', async () => {
    const { root } = fixture();
    const home = tmp('moe-home-'); fs.writeFileSync(path.join(home, '.gitconfig'), '[remote "o"]\n\tpromisor = true\n');
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('XDG_CONFIG_HOME', home);
    await expect(openProjectGit(root)).resolves.toBeTypeOf('function');
  });
});
