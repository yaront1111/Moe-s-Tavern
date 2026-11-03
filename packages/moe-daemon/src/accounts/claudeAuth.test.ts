import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runAccountsCli } from './cli.js';
import { ProtectedClaudeRefused, claudeCommand, probeSignIn, protectedClaudeCommand, runClaude, type ClaudeCommand } from './claudeAuth.js';
import { accountConfigDir, readRegistry } from './registry.js';

// A claude that is not on PATH, when PATH holds a directory the process cannot
// search. POSIX execvp keeps searching past such a directory and then fails
// EACCES, not ENOENT. These are libuv/Linux semantics, and root bypasses
// directory permissions, so the cases run only for a non-root Linux user.

const MISSING_BIN = 'moe-no-such-claude-binary';
const STATUS_ARGS = ['auth', 'status', '--json'];

describe.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('runClaude with a claude that cannot be found', { timeout: 30_000 }, () => {
  let dir: string;
  let locked: string;
  let empty: string;
  let registryFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-claude-auth-'));
    locked = path.join(dir, 'locked');
    empty = path.join(dir, 'empty');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    fs.mkdirSync(empty);
    registryFile = path.join(dir, 'claude-accounts.json');
  });

  afterEach(() => {
    // Restore the mode first, so the cleanup works even after a failed assertion.
    fs.chmodSync(locked, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Proves the case takes the EACCES branch and cannot pass through ENOENT. */
  function expectRawEacces(pathValue: string): void {
    const code = (spawnSync(MISSING_BIN, [], { env: { PATH: pathValue } }).error as NodeJS.ErrnoException | undefined)?.code;
    expect(code).toBe('EACCES');
  }

  const bare = (): ClaudeCommand => claudeCommand({ MOE_CLAUDE_BIN: MISSING_BIN }, 'linux');

  function cli(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const env: NodeJS.ProcessEnv = { MOE_ACCOUNTS_FILE: registryFile, MOE_CLAUDE_BIN: MISSING_BIN, PATH: locked };
    const code = runAccountsCli(argv, { out: (line) => out.push(line), err: (line) => err.push(line), env });
    return { code, out, err, errText: err.join('\n') };
  }

  it('reports a bare name behind an unsearchable PATH directory as not found', () => {
    expectRawEacces(locked);
    expect(runClaude(bare(), STATUS_ARGS, { PATH: locked }, false)).toEqual({ status: null, stdout: '', notFound: true });
    expect(probeSignIn(bare(), { PATH: locked })).toEqual({ state: 'unknown', notFound: true });
    const mixed = `${empty}:${locked}`;
    expectRawEacces(mixed);
    expect(runClaude(bare(), STATUS_ARGS, { PATH: mixed }, false).notFound).toBe(true);
  });

  it('still reports an explicit path that exists but cannot run as not notFound', () => {
    const noExec = path.join(dir, 'claude-no-exec');
    fs.writeFileSync(noExec, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const command: ClaudeCommand = { file: noExec, prefix: [], shell: false, missing: false };
    const run = runClaude(command, STATUS_ARGS, { PATH: empty }, false);
    expect(run.notFound).toBe(false);
    expect(run.status).toBeNull();
  });

  it('keeps reporting a bare name missing from a searchable PATH as not found', () => {
    const code = (spawnSync(MISSING_BIN, [], { env: { PATH: empty } }).error as NodeJS.ErrnoException | undefined)?.code;
    expect(code).toBe('ENOENT');
    expect(runClaude(bare(), STATUS_ARGS, { PATH: empty }, false)).toEqual({ status: null, stdout: '', notFound: true });
  });

  it('makes the accounts CLI say MOE_CLAUDE_NOT_FOUND instead of reading the account as unknown', () => {
    expectRawEacces(locked);
    expect(cli(['add']).code).toBe(0);

    const checked = cli(['check']);
    expect(checked.code).toBe(1);
    expect(checked.errText).toContain(`MOE_CLAUDE_NOT_FOUND: could not run "${MISSING_BIN}"`);
    expect(readRegistry(registryFile)!.accounts.find((entry) => entry.id === 'acct-1')!.signInCheckedAt).toBeNull();

    const login = cli(['login', 'acct-1']);
    expect(login.code).toBe(1);
    expect(login.errText).toContain('MOE_CLAUDE_NOT_FOUND');
  });
});

// task-55710898: with --protected-project the CLI resolves claude only in absolute
// PATH entries outside the project, and runs it with PATH = those entries and
// cwd = the home folder (on Windows also NoDefaultCurrentDirectoryInExePath=1 and
// the System32 cmd.exe for a .cmd shim). Project plants log PLANT; the trusted
// fake claude logs what its node saw.

const WIN = process.platform === 'win32';
const real = (p: string): string => fs.realpathSync.native(p);
const NODE_DIR = path.dirname(process.execPath);
const SAVED_CWD = process.cwd();
const NPM_SHIM = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\fake-claude.mjs" %*', ''].join('\r\n');
const FAKE_BODY = `fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(),
  path: process.env.PATH, node: process.execPath, nodefault: process.env.NoDefaultCurrentDirectoryInExePath ?? null }) + '\\n');
if (process.argv.slice(2).join(' ') === 'auth status --json') process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai"}');
`;

let fx: ReturnType<typeof makeFixture>;

function makeFixture() {
  const root = real(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-protected-claude-')));
  const at = (...parts: string[]) => path.join(root, ...parts);
  for (const dir of [['project', 'bin'], ['project', 'home'], ['trusted'], ['other'], ['home']]) fs.mkdirSync(at(...dir), { recursive: true });
  const plant = WIN ? '@echo PLANT>>"%PLANT_LOG%"\r\n@exit /b 0\r\n' : '#!/bin/sh\necho PLANT >> "$PLANT_LOG"\n';
  for (const dir of [at('project'), at('project', 'bin')]) {
    for (const name of WIN ? ['claude.cmd', 'node.bat'] : ['claude', 'node']) fs.writeFileSync(path.join(dir, name), plant, { mode: 0o755 });
  }
  const fake = at('trusted', WIN ? 'fake-claude.mjs' : 'claude');
  fs.writeFileSync(fake, WIN ? `import fs from 'fs';\n${FAKE_BODY}` : `#!/usr/bin/env node\nconst fs = require('fs');\n${FAKE_BODY}`, { mode: 0o755 });
  if (WIN) fs.writeFileSync(at('trusted', 'claude.cmd'), NPM_SHIM);
  else {
    fs.writeFileSync(at('other', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    fs.symlinkSync(at('project', 'bin'), at('link'));
  }
  return {
    root, project: at('project'), bin: at('project', 'bin'), trusted: at('trusted'), other: at('other'), home: at('home'), link: at('link'),
    registry: at('claude-accounts.json'), claudeLog: at('claude.log'), plantLog: at('plant.log'), fake,
  };
}

/** A fresh fixture per case, removed even after a failed assertion (inDir has restored the cwd by then). */
function withFixture(): void {
  beforeEach(() => void (fx = makeFixture()));
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));
}

function inDir<T>(dir: string, fn: () => T): T {
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(SAVED_CWD);
  }
}

function runCli(argv: string[], env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runAccountsCli(argv, { out: (line) => out.push(line), err: (line) => err.push(line), env, readSecret: () => null });
  return { code, out, err };
}

const refused = (reason: string) => `MOE_PROTECTED_CLAUDE_REFUSED: ${reason}; nothing was run.`;
const notFound = (project: string) =>
  `MOE_PROTECTED_CLAUDE_NOT_FOUND: "claude" was not found on an absolute PATH entry outside the project ${project}; nothing was run. Install Claude Code outside the project and put its folder on PATH, then try again.`;
const lastFakeRun = () => JSON.parse(fs.readFileSync(fx.claudeLog, 'utf8').trim().split('\n').pop()!);
type Refusal = [project: string, env: NodeJS.ProcessEnv, message: string];

/** Each row throws exactly its message (pc1 shows the CLI prints it as a ProtectedClaudeRefused). */
function expectRefusals(rows: Refusal[]): void {
  inDir(fx.project, () => {
    for (const [project, env, message] of rows) expect(() => protectedClaudeCommand(env, project)).toThrow(new ProtectedClaudeRefused(message));
  });
}

/** add acct-1, show legacy `check` runs the project plant, then run `check` with the option. */
function legacyThenProtected(env: NodeJS.ProcessEnv, before: () => void = () => {}) {
  return inDir(fx.project, () => {
    expect(runCli(['add'], env).code).toBe(0);
    runCli(['check', 'acct-1'], env);
    expect(fs.existsSync(fx.plantLog)).toBe(true);
    fs.rmSync(fx.plantLog);
    before();
    return runCli(['--protected-project', fx.project, 'check', 'acct-1'], env);
  });
}

describe.runIf(!WIN)('protected claude lookup on POSIX', { timeout: 30_000 }, () => {
  withFixture();
  const env = (entries: string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ HOME: fx.home, PATH: entries.join(':'), ...extra });

  it('(pp1) keeps only absolute PATH entries outside the project, and takes the first executable claude there', () => {
    const entries = ['.', '', 'bin', '../home', fx.project, fx.bin, fx.link, fx.other, fx.trusted, NODE_DIR, fx.trusted];
    expect(inDir(fx.project, () => protectedClaudeCommand(env(entries), fx.project))).toEqual({
      file: path.join(fx.trusted, 'claude'), prefix: [], shell: false, missing: false,
      pinned: { path: [fx.other, fx.trusted, real(NODE_DIR)].join(':'), cwd: fx.home },
    });
  });

  it('(pp2) refuses when the project, PATH, home, MOE_CLAUDE_BIN or every claude fails the rule', () => {
    const hidden = env(['.', '', 'bin', fx.bin, fx.link, fx.other]);
    const missing = path.join(fx.root, 'missing');
    const file = path.join(fx.bin, 'claude');
    const inHome = path.join(fx.project, 'home');
    expectRefusals([
      [fx.project, hidden, notFound(fx.project)],
      ...['rel/project', missing, file].map((project): Refusal => [project, hidden, refused(`the project ${project} is not a local folder`)]),
      [fx.project, env([fx.bin]), refused(`no absolute PATH entry is outside the project ${fx.project}`)],
      [fx.project, env([fx.other], { HOME: inHome }), refused(`the home folder ${inHome} is not a local folder outside the project ${fx.project}`)],
      ...['bin/claude', path.join(fx.project, 'claude'), path.join(fx.link, 'claude')].map((bin): Refusal =>
        [fx.project, env([fx.other], { MOE_CLAUDE_BIN: bin }), refused(`MOE_CLAUDE_BIN ${bin} is not an absolute file outside the project ${fx.project}`)]),
    ]);
  });

  it('(pp3) runs the outside claude and node with PATH = the kept entries and cwd = home, where legacy runs the project plant', () => {
    const base = { MOE_ACCOUNTS_FILE: fx.registry, FAKE_CLAUDE_LOG: fx.claudeLog, PLANT_LOG: fx.plantLog };
    const result = legacyThenProtected({ ...base, ...env(['.', 'bin', fx.bin, fx.trusted, NODE_DIR]) });
    expect(result).toEqual({ code: 0, out: ['acct-1\tacct-1\tsubscription'], err: [] });
    expect(fs.existsSync(fx.plantLog)).toBe(false);
    expect(lastFakeRun()).toMatchObject({ argv: ['auth', 'status', '--json'], cwd: fx.home, path: `${fx.trusted}:${real(NODE_DIR)}`, node: real(process.execPath) });
  });
});

describe.runIf(WIN)('protected claude lookup on Windows', { timeout: 30_000 }, () => {
  withFixture();
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const cmd = () => real(path.win32.join(systemRoot, 'System32', 'cmd.exe'));
  const env = (entries: string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ Path: entries.join(';'), USERPROFILE: fx.home, SystemRoot: systemRoot, ...extra });

  it('(pw1) takes PATHEXT order inside one kept entry, and pins cmd.exe only for a .cmd or .bat claude', () => {
    for (const name of ['claude.exe', 'claude.bat', 'claude.cmd']) fs.writeFileSync(path.join(fx.other, name), '');
    const pick = (pathext: string | undefined) => protectedClaudeCommand(env([fx.other], { PATHEXT: pathext }), fx.project);
    const shim = (name: string) => ({ file: path.join(fx.other, name), prefix: [], shell: true, missing: false, pinned: { path: fx.other, cwd: fx.home, cmd: cmd() } });
    expect(pick('.CMD;.BAT')).toStrictEqual(shim('claude.cmd'));
    expect(pick('.BAT;.CMD')).toStrictEqual(shim('claude.bat'));
    for (const pathext of ['.EXE;.CMD', undefined]) {
      expect(pick(pathext)).toStrictEqual({ file: path.join(fx.other, 'claude.exe'), prefix: [], shell: false, missing: false, pinned: { path: fx.other, cwd: fx.home } });
    }
  });

  it('(pw2) keeps only drive-qualified entries outside the project, whatever their spelling', () => {
    const entries = ['.', '', 'bin', '..\\home', fx.project, fx.bin.toUpperCase(), fx.bin.replace(/\\/g, '/'), `"${fx.trusted}"`, NODE_DIR];
    expect(inDir(fx.project, () => protectedClaudeCommand(env(entries), fx.project))).toStrictEqual({
      file: path.join(fx.trusted, 'claude.cmd'), prefix: [], shell: true, missing: false,
      pinned: { path: `${fx.trusted};${real(NODE_DIR)}`, cwd: fx.home, cmd: cmd() },
    });
  });

  it('(pw3) runs the shim through the pinned cmd.exe, PATH and cwd, so it finds the outside node, where legacy runs the project plant', () => {
    const base = { MOE_ACCOUNTS_FILE: fx.registry, FAKE_CLAUDE_LOG: fx.claudeLog, PLANT_LOG: fx.plantLog, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const comSpec = process.env.ComSpec;
    let result: ReturnType<typeof runCli> | undefined;
    try {
      // Only the pinned cmd.exe can start the shim once ComSpec names a missing project copy.
      result = legacyThenProtected({ ...base, ...env(['.', 'bin', fx.bin, fx.trusted, NODE_DIR]) }, () => {
        process.env.ComSpec = path.join(fx.project, 'cmd.exe');
      });
    } finally {
      if (comSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = comSpec;
    }
    expect(result).toEqual({ code: 0, out: ['acct-1\tacct-1\tsubscription'], err: [] });
    expect(fs.existsSync(fx.plantLog)).toBe(false);
    expect(lastFakeRun()).toMatchObject({ cwd: fx.home, path: `${fx.trusted};${real(NODE_DIR)}`, node: real(process.execPath), nodefault: '1' });
  });

  it('(pw4) refuses a missing or in-project cmd.exe, a drive-relative or UNC project, and a claude only inside the project', () => {
    fs.mkdirSync(path.join(fx.project, 'System32'));
    fs.writeFileSync(path.join(fx.project, 'System32', 'cmd.exe'), '');
    const drive = fx.root.slice(0, 2);
    const unc = `\\\\localhost\\${drive[0]}$${fx.project.slice(2)}`;
    const shimIn = (root: string | undefined) => refused(`cmd.exe under SystemRoot ${root ?? '(unset)'} is not a local file outside the project ${fx.project}`);
    expectRefusals([
      [fx.project, env([fx.trusted], { SystemRoot: undefined }), shimIn(undefined)],
      [fx.project, env([fx.trusted], { SystemRoot: fx.project }), shimIn(fx.project)],
      ...[`${drive}rel\\project`, unc].map((project): Refusal => [project, env([fx.trusted]), refused(`the project ${project} is not a local folder`)]),
      [fx.project, env([fx.bin, fx.other]), notFound(fx.project)],
    ]);
  });
});

describe('protected accounts CLI option', { timeout: 30_000 }, () => {
  withFixture();

  it('(pc1) needs a value, leaves add and list alone, and refuses every claude command before any side effect', () => {
    const env = { MOE_ACCOUNTS_FILE: fx.registry, FAKE_CLAUDE_LOG: fx.claudeLog, MOE_CLAUDE_BIN: fx.fake, HOME: fx.home, USERPROFILE: fx.home, PATH: process.env.PATH };
    const usage = runCli(['--protected-project'], env);
    expect(usage.code).toBe(2);
    expect(usage.err[0]).toBe('accounts: --protected-project needs a value');
    expect(runCli(['--protected-project', 'rel', 'add'], env).code).toBe(0);
    expect(runCli(['--protected-project', 'rel', 'list'], env).code).toBe(0);
    for (const argv of [['login', 'acct-1'], ['logout', 'acct-1'], ['check', 'acct-1'], ['vm-token', 'acct-1'], ['remove', 'acct-1', '--sign-out']]) {
      expect(runCli(['--protected-project', 'rel', ...argv], env)).toEqual({ code: 1, out: [], err: [refused('the project rel is not a local folder')] });
      expect(fs.existsSync(accountConfigDir(fx.registry, 'acct-1'))).toBe(false);
      expect(readRegistry(fx.registry)!.accounts).toMatchObject([{ id: 'acct-1', signInCheckedAt: null }]);
    }
    expect(fs.existsSync(fx.claudeLog)).toBe(false);
    expect(claudeCommand({ PATH: '.' }, 'linux')).toStrictEqual({ file: 'claude', prefix: [], shell: false, missing: false });
  });
});
