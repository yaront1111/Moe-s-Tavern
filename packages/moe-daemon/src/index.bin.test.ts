import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isEntryModule } from './index.js';
import { VERSION } from './util/version.js';

// Off Windows, npm's bin (npm install -g, npm link, npx) is a symlink to dist/index.js, and Node
// loads the main module by its real path: the entry guard must still run main() through the link.
const entrypoint = fileURLToPath(new URL('./index.ts', import.meta.url));
// The child's cwd is a fixture repo, so resolve the tsx loader here rather than by bare name.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const RULES = `${JSON.stringify({ version: 1, rules: [{ id: 'state-no-tools', from: ['src/state'], forbid: ['src/tools'], reason: 'state must not depend on tools' }] })}\n`;
const FORBIDDEN = "import { t } from '../tools/t.js';\nexport const s = t;\n";

const cleanEnv = () => Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.startsWith('MOE_') && !key.toUpperCase().startsWith('GIT_')));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], {
    cwd, encoding: 'utf8', env: { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' },
  }).trim();
}
function commit(cwd: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
  }
  git(cwd, ['add', '-A']); git(cwd, ['commit', '-qm', 'fixture']);
}
const cli = (entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = cleanEnv()) =>
  spawnSync(process.execPath, ['--import', tsx, entry, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });

let tmp = '';
let link = '';
beforeEach(() => {
  // macOS's tmpdir is itself a symlink, so resolve it before building paths to compare.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-bin-')));
  link = path.join(tmp, 'prefix', 'bin', 'moe-daemon');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Symlinks need privileges on Windows, whose npm bin is a .cmd shim that runs node on the real file.
describe.skipIf(process.platform === 'win32')('installed bin: an npm bin symlink to the entry', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(entrypoint, link);
  });

  it('B1: version through the symlink prints the package version', () => {
    const project = path.join(tmp, 'project');
    fs.mkdirSync(project);
    const result = cli(link, ['version'], tmp, { ...cleanEnv(), MOE_PROJECT_PATH: project });
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr })
      .toEqual({ status: 0, stdout: `${VERSION}\n`, stderr: '' });
    expect(fs.readdirSync(project)).toEqual([]);
  }, 60_000);

  it('B2: check-architecture through the symlink reports the same violation as the direct entry', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q']);
    commit(repo, { 'arch.json': RULES, 'src/state/s.ts': 'export const s = 1;\n', 'src/tools/t.ts': 'export const t = 1;\n' });
    commit(repo, { 'src/state/s.ts': FORBIDDEN });
    const args = ['check-architecture', '--rules', 'arch.json'];
    const direct = cli(entrypoint, args, repo);
    const linked = cli(link, args, repo);
    for (const result of [direct, linked]) {
      const lines = result.stdout.split('\n').filter(Boolean);
      expect({ status: result.status, lines: lines.length }).toEqual({ status: 1, lines: 1 });
      const report = JSON.parse(lines[0]);
      expect({ outcome: report.outcome, ruleId: report.violations[0]?.ruleId }).toEqual({ outcome: 'failed', ruleId: 'state-no-tools' });
    }
    expect(linked.stdout).toBe(direct.stdout);
  }, 60_000);
});

describe('isEntryModule', () => {
  const moduleUrl = () => pathToFileURL(fs.realpathSync(entrypoint)).href;

  it('B3a: no argv[1] is never the entry', () => {
    expect([isEntryModule(undefined, moduleUrl()), isEntryModule('', moduleUrl())]).toEqual([false, false]);
  });
  it('B3b: the entry by its own path is the entry', () => {
    expect(isEntryModule(fs.realpathSync(entrypoint), moduleUrl())).toBe(true);
  });
  it.skipIf(process.platform === 'win32')('B3c: a symlink to the entry is the entry', () => {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(entrypoint, link);
    expect(isEntryModule(link, moduleUrl())).toBe(true);
  });
  it('B3d: another existing file is not the entry', () => {
    expect(isEntryModule(fileURLToPath(import.meta.url), moduleUrl())).toBe(false);
  });
  it('B3e: a path that does not exist is not the entry, without throwing', () => {
    expect(isEntryModule(path.join(tmp, 'no-such-moe-entry.js'), moduleUrl())).toBe(false);
  });
});

// npm sets a bin's mode only at install time, so a rebuild behind `npm link` must keep it runnable.
const builtEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
describe.skipIf(process.platform === 'win32' || !fs.existsSync(builtEntry))('built bin', () => {
  it('B4: dist/index.js is executable', () => {
    expect(() => fs.accessSync(builtEntry, fs.constants.X_OK)).not.toThrow();
  });
});
