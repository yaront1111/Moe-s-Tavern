import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit, runGitHead } from './cachedPlanPaths.js';
import { defaultGitRunner } from './diskState.js';
import { gitExecutable, resolveGitExecutable } from './gitExecutable.js';

/** isFile stub that records every probe and says yes only to `existing`. */
function probe(existing: string[] | 'all') {
  const probes: string[] = [];
  const isFile = (file: string) => {
    probes.push(file);
    return existing === 'all' || existing.includes(file);
  };
  return { probes, isFile };
}

describe('resolveGitExecutable', () => {
  it.each(['linux', 'darwin'] as const)('returns the bare name on %s without probing', platform => {
    const { probes, isFile } = probe('all');
    expect(resolveGitExecutable(platform, '/usr/bin:/bin', isFile)).toBe('git');
    expect(probes).toEqual([]);
  });

  it('skips blank, relative, drive-relative and root-relative PATH entries without probing them', () => {
    const { probes, isFile } = probe('all');
    const pathValue = ';  ;.;bin;.\\tools;C:tools;\\tools;/tools;"C:\\Program Files\\Git\\cmd";D:\\later';
    expect(resolveGitExecutable('win32', pathValue, isFile)).toBe('C:\\Program Files\\Git\\cmd\\git.com');
    expect(probes).toEqual(['C:\\Program Files\\Git\\cmd\\git.com']);
  });

  it('honours PATH order first, then .com before .exe within a folder', () => {
    const { probes, isFile } = probe(['C:\\a\\git.exe', 'C:\\b\\git.com']);
    expect(resolveGitExecutable('win32', 'C:\\a;C:\\b', isFile)).toBe('C:\\a\\git.exe');
    expect(probes).toEqual(['C:\\a\\git.com', 'C:\\a\\git.exe']);
  });

  it('accepts a UNC entry and a forward-slash drive entry', () => {
    expect(resolveGitExecutable('win32', '\\\\srv\\tools', probe('all').isFile)).toBe('\\\\srv\\tools\\git.com');
    expect(resolveGitExecutable('win32', 'c:/git/cmd', probe('all').isFile)).toBe('c:\\git\\cmd\\git.com');
  });

  it('skips an entry whose candidates are not files (a directory named git.exe)', () => {
    const { isFile } = probe(['D:\\real\\git.exe']);
    expect(resolveGitExecutable('win32', 'C:\\dir-named-git;D:\\real', isFile)).toBe('D:\\real\\git.exe');
  });

  it.each([
    ['an empty PATH', ''],
    ['only relative entries', '.;bin;.\\tools;C:tools;\\tools'],
    ['only blank entries', ' ; ;;'],
  ])('throws ENOENT on win32 for %s, even if every probe would succeed', (_label, pathValue) => {
    let result: string | undefined;
    let thrown: unknown;
    try {
      result = resolveGitExecutable('win32', pathValue, probe('all').isFile);
    } catch (error) {
      thrown = error;
    }
    expect(result).toBeUndefined();
    expect((thrown as { code?: unknown }).code).toBe('ENOENT');
  });

  it('throws ENOENT when no fully qualified entry holds git', () => {
    expect(() => resolveGitExecutable('win32', 'C:\\a;D:\\b', probe([]).isFile))
      .toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});

// Real spawns, no mocks. CI runs daemon tests on ubuntu only, so a Windows-native
// run is the evidence for this block. whoami.exe stands in for a planted binary:
// it rejects `--version`, so a runner that executes the cwd copy fails the match.
describe.runIf(process.platform === 'win32')('git planted in the spawn cwd (Windows)', () => {
  let cwd: string;
  beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-git-planted-')); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it.each(['git.exe', 'git.com'])('runs the PATH git, not a %s in the cwd', async name => {
    fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), path.join(cwd, name));
    const resolved = gitExecutable();
    expect(path.win32.isAbsolute(resolved)).toBe(true);
    expect(path.win32.relative(cwd, resolved).startsWith('..')).toBe(true);
    expect(await defaultGitRunner(['--version'], cwd)).toMatch(/^git version /);
    expect(await runGit(['--version'], cwd, 10_000)).toMatch(/^git version /);
    const head = await runGitHead(['--version'], cwd, 10_000, 4096);
    expect(head.stdout.toString('utf8')).toMatch(/^git version /);
  });
});
