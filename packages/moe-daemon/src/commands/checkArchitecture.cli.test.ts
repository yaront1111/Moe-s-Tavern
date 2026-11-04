import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// check-architecture as the installed CLI runs it, through index.ts main(): one JSON line on stdout and exit 0 passed,
// 1 failed, 2 inconclusive or unavailable, even for arguments the daemon-wide parseArgs() would throw on.
const entry = fileURLToPath(new URL('../index.ts', import.meta.url));
// The child runs in the fixture repository, where a bare `tsx` does not resolve.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const RULES = `${JSON.stringify({ version: 1, rules: [{ id: 'a', from: ['src/a'], forbid: ['src/b'], reason: 'r' }] })}\n`;
let repo = '';
let scratch = '';

function git(cwd: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], {
    cwd, encoding: 'utf8', env: { ...env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' },
  }).trim();
}

/** Spawns the entry as src/index.version.test.ts does, without the seat's MOE_* variables. */
function cli(args: string[], nodeEnv: string, extra: { imports?: string[]; env?: Record<string, string> } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MOE_')));
  const imports = ['--import', tsx, ...(extra.imports ?? []).flatMap(url => ['--import', url])];
  return spawnSync(process.execPath, [...imports, entry, 'check-architecture', ...args], {
    cwd: repo, env: { ...env, ...extra.env, NODE_ENV: nodeEnv }, encoding: 'utf8', timeout: 30_000 });
}

/** The exit status and the one JSON line that must be the child's whole stdout. */
function outcome(result: SpawnSyncReturns<string>) {
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  const lines = result.stdout.split('\n');
  expect(lines, result.stdout).toHaveLength(2);
  expect(lines[1]).toBe('');
  return { status: result.status, report: JSON.parse(lines[0]) as Record<string, unknown> };
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-check-arch-cli-')));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-check-arch-cli-scratch-'));
  git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'arch.json'), RULES);
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'one']);
  fs.writeFileSync(path.join(repo, 'x.md'), 'x\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'two']);
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

const usage = (detail: string) => ({ status: 2, report: { detail, outcome: 'unavailable', reason: 'usage' } });

describe('check-architecture CLI dispatch (index.ts main)', () => {
  it.each(['production', 'development'])('a trailing --project (an empty variable) is a usage report with exit 2, NODE_ENV=%s', (mode) => {
    expect(outcome(cli(['--rules', 'arch.json', '--project'], mode))).toEqual(usage('unexpected argument "--project"'));
  });

  it.each([
    [['--rules', 'arch.json', '--project', ''], 'unexpected argument "--project"'],
    [['--rules', 'arch.json', '--bogus'], 'unexpected argument "--bogus"'],
  ])('%j keeps its usage report with exit 2', (args, detail) => {
    expect(outcome(cli(args, 'production'))).toEqual(usage(detail));
  });

  it('a valid call still runs the check: passed with exit 0', () => {
    const { status, report } = outcome(cli(['--rules', 'arch.json'], 'production'));
    expect({ status, outcome: report.outcome, rules: report.rules }).toEqual({ status: 0, outcome: 'passed', rules: 'arch.json' });
  });

  // Windows refuses to remove a live process's working directory. Production mode only: outside it the logger's
  // pino-pretty transport worker itself fails in a deleted cwd (10 s, exit 1), a logger issue outside this dispatch.
  it.skipIf(process.platform === 'win32')('a deleted working directory is repository-unavailable with exit 2', () => {
    // tsx reads the cwd while it loads, so the child removes its own cwd after tsx loaded and before main() runs.
    const gone = fs.mkdtempSync(path.join(scratch, 'gone-'));
    const remove = path.join(scratch, 'remove-cwd.mjs');
    fs.writeFileSync(remove, "import fs from 'node:fs';\nprocess.chdir(process.env.CHECK_ARCH_GONE);\nfs.rmdirSync(process.env.CHECK_ARCH_GONE);\n");
    const { status, report } = outcome(cli(['--rules', 'arch.json'], 'production',
      { imports: [pathToFileURL(remove).href], env: { CHECK_ARCH_GONE: gone } }));
    expect({ status, outcome: report.outcome, reason: report.reason }).toEqual({ status: 2, outcome: 'unavailable', reason: 'repository-unavailable' });
    expect(report.detail).toMatch(/ENOENT/);
  });
});
