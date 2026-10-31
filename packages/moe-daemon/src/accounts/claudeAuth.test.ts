import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runAccountsCli } from './cli.js';
import { claudeCommand, probeSignIn, runClaude, type ClaudeCommand } from './claudeAuth.js';
import { readRegistry } from './registry.js';

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
