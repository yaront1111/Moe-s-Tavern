import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runAccountsCli } from './cli.js';
import { ACCOUNT_ID_RE, PROVIDER_ENV, RegistryError, TOKEN_ENV, accountConfigDir, addAccount, removeAccount, vmTokenFile } from './registry.js';
import { HIDDEN_READER_SOURCE, MAX_VM_TOKEN_BYTES, VM_TOKEN_RE, hasVmToken, removeVmToken, writeVmToken } from './vmTokens.js';

// The VM token store (accounts/vmTokens.ts) and `accounts vm-token`. Fake
// tokens and a fake claude (MOE_CLAUDE_BIN) only: no real Claude config folder
// is touched.

const TOKEN = `sk-ant-oat01-${'Q7x_Lm2-Zp9K'.repeat(4)}`;
const posix = process.platform !== 'win32';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-vm-tokens-'));
  file = path.join(dir, 'claude-accounts.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const store = () => path.join(dir, 'claude-vm-tokens');

/** false where the OS refuses a symlink (Windows without the privilege). */
function trySymlink(target: string, link: string, type?: 'dir'): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

describe('VM token store', () => {
  it('stores exactly the token, owner-only, and replaces it without leftovers', () => {
    writeVmToken(file, 'acct-1', `sk-ant-oat01-${'a'.repeat(30)}`);
    writeVmToken(file, 'acct-1', TOKEN);
    const tokenFile = vmTokenFile(file, 'acct-1');
    expect(tokenFile).toBe(path.join(store(), 'acct-1.token'));
    expect(fs.readFileSync(tokenFile, 'utf8')).toBe(TOKEN);
    expect(fs.readdirSync(store())).toEqual(['acct-1.token']);
    if (posix) {
      expect(fs.statSync(store()).mode & 0o777).toBe(0o700);
      expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ['an empty token', ''],
    ['an API key', `sk-ant-api03-${'b'.repeat(40)}`],
    ['a trailing newline', `${TOKEN}\n`],
    ['an inner space', `${TOKEN.slice(0, 20)} ${TOKEN.slice(20)}`],
    ['a 1001-character body', `sk-ant-oat01-${'c'.repeat(1001)}`],
  ])('refuses %s without echoing it', (_name, token) => {
    expect(() => writeVmToken(file, 'acct-1', token)).toThrow(/^MOE_VM_TOKEN_INVALID: not a Claude long-lived token$/);
    expect(fs.existsSync(store())).toBe(false);
  });

  it.each(['../x', 'a/b', ''])('refuses the account id %j', (id) => {
    expect(() => writeVmToken(file, id, TOKEN)).toThrow(RegistryError);
    expect(fs.existsSync(store())).toBe(false);
  });

  it('refuses a symlinked store directory', () => {
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    if (!trySymlink(elsewhere, store(), 'dir')) return;
    expect(() => writeVmToken(file, 'acct-1', TOKEN)).toThrow(/^MOE_VM_TOKEN_NOT_STORED: /);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('removes a token once, and reports presence from the entry type alone', () => {
    expect(hasVmToken(file, 'acct-1')).toBe(false);
    writeVmToken(file, 'acct-1', TOKEN);
    expect(hasVmToken(file, 'acct-1')).toBe(true);
    fs.mkdirSync(vmTokenFile(file, 'acct-2'));
    expect(hasVmToken(file, 'acct-2')).toBe(false);
    if (trySymlink(vmTokenFile(file, 'acct-1'), vmTokenFile(file, 'acct-3'))) expect(hasVmToken(file, 'acct-3')).toBe(false);
    expect(hasVmToken(file, '../acct-1')).toBe(false);
    expect(removeVmToken(file, 'acct-1')).toBe(true);
    expect(removeVmToken(file, 'acct-1')).toBe(false);
    expect(hasVmToken(file, 'acct-1')).toBe(false);
  });

  it('registry removal deletes only that account token, and a reused id starts without one', () => {
    addAccount(file);
    addAccount(file);
    writeVmToken(file, 'acct-1', TOKEN);
    writeVmToken(file, 'acct-2', TOKEN);
    removeAccount(file, 'acct-1');
    expect([hasVmToken(file, 'acct-1'), hasVmToken(file, 'acct-2')]).toEqual([false, true]);
    // acct-1 never got a config folder, so add reuses the id: a stale token must not carry over.
    writeVmToken(file, 'acct-1', TOKEN);
    expect(addAccount(file).id).toBe('acct-1');
    expect(hasVmToken(file, 'acct-1')).toBe(false);
  });
});

// Logs its arguments, its config folder and the NAMES of the credential variables it got.
const FAKE_CLAUDE = `
import fs from 'fs';
const watched = ${JSON.stringify([...TOKEN_ENV, ...PROVIDER_ENV])};
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
  args: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR ?? null, leaked: watched.filter((name) => name in process.env),
}) + '\\n');
process.exit(Number(process.env.FAKE_SETUP_EXIT || 0));
`;

describe('accounts vm-token', { timeout: 30_000 }, () => {
  let logFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    logFile = path.join(dir, 'fake-claude.log');
    fs.writeFileSync(path.join(dir, 'fake-claude.mjs'), FAKE_CLAUDE);
    env = {
      ...process.env,
      MOE_ACCOUNTS_FILE: file,
      MOE_CLAUDE_BIN: path.join(dir, 'fake-claude.mjs'),
      FAKE_CLAUDE_LOG: logFile,
      ANTHROPIC_API_KEY: 'sk-ant-test',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test',
      CLAUDE_CODE_USE_BEDROCK: '1',
    };
    addAccount(file);
  });

  function cli(argv: string[], paste: () => string | null = () => TOKEN, extra: NodeJS.ProcessEnv = {}) {
    const out: string[] = [];
    const err: string[] = [];
    let asked = 0;
    const readSecret = () => (asked++, paste());
    const code = runAccountsCli(argv, { out: (line) => out.push(line), err: (line) => err.push(line), env: { ...env, ...extra }, readSecret });
    return { code, out, err, asked, all: [...out, ...err].join('\n') };
  }

  const fakeCalls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);

  it('mints in the account folder without outer credentials, stores the trimmed paste and never prints it', () => {
    const result = cli(['vm-token', 'acct-1'], () => ` ${TOKEN}\r`);
    expect([result.code, result.asked]).toEqual([0, 1]);
    expect(result.out).toEqual(["Stored a VM token for acct-1. Moe uses it only to run this account's agent jobs in a Moe VM."]);
    expect(fs.readFileSync(vmTokenFile(file, 'acct-1'), 'utf8')).toBe(TOKEN);
    if (posix) expect([fs.statSync(store()).mode & 0o777, fs.statSync(vmTokenFile(file, 'acct-1')).mode & 0o777]).toEqual([0o700, 0o600]);
    for (let i = 0; i + 12 <= TOKEN.length; i++) expect(result.all).not.toContain(TOKEN.slice(i, i + 12));
    expect(fakeCalls()).toEqual([{ args: ['setup-token'], configDir: accountConfigDir(file, 'acct-1'), leaked: [] }]);
  });

  it('stores nothing and never asks for a token when setup-token fails', () => {
    const result = cli(['vm-token', 'acct-1'], () => TOKEN, { FAKE_SETUP_EXIT: '1' });
    expect([result.code, result.asked]).toEqual([1, 0]);
    expect(result.err.at(-1)).toBe('MOE_VM_TOKEN_MINT_FAILED: claude setup-token exited with 1; nothing was stored.');
    expect(fs.existsSync(store())).toBe(false);
  });

  it.each([
    ['no input', null, 'MOE_VM_TOKEN_NOT_STORED: no token was entered; nothing was stored.'],
    ['an empty line', '', 'MOE_VM_TOKEN_NOT_STORED: no token was entered; nothing was stored.'],
    ['an API key', `sk-ant-api03-${'d'.repeat(40)}`, 'MOE_VM_TOKEN_INVALID: that is not a Claude long-lived token (sk-ant-oat…); nothing was stored.'],
  ])('stores nothing for %s', (_name, paste, message) => {
    const result = cli(['vm-token', 'acct-1'], () => paste);
    expect(result.code).toBe(1);
    expect(result.err.at(-1)).toBe(message);
    expect(fs.existsSync(store())).toBe(false);
  });

  it('refuses a missing id, an unknown account, one removed during the prompt, and a broken store', () => {
    expect(cli(['vm-token']).code).toBe(2);
    expect(cli(['vm-token', 'acct-9'])).toMatchObject({ code: 1, err: ['MOE_ACCOUNT_UNKNOWN: no Claude account "acct-9" is registered'] });
    expect(fakeCalls()).toEqual([]);
    const raced = cli(['vm-token', 'acct-1'], () => (removeAccount(file, 'acct-1'), TOKEN));
    expect([raced.code, raced.err.at(-1)]).toEqual([1, 'MOE_ACCOUNT_UNKNOWN: no Claude account "acct-1" is registered']);
    expect(fs.existsSync(store())).toBe(false);
    const id = addAccount(file).id;
    fs.writeFileSync(store(), 'not a folder');
    expect(cli(['vm-token', id]).err.at(-1)).toBe('MOE_VM_TOKEN_NOT_STORED: the token store could not be written (EEXIST); nothing was stored.');
  });

  it('--remove deletes the token, then says there is none', () => {
    writeVmToken(file, 'acct-1', TOKEN);
    expect(cli(['vm-token', 'acct-1', '--remove'])).toMatchObject({ code: 0, out: ['Removed the VM token for acct-1.'] });
    expect(hasVmToken(file, 'acct-1')).toBe(false);
    expect(cli(['vm-token', 'acct-1', '--remove'])).toMatchObject({ code: 0, out: ['acct-1 has no VM token.'] });
    expect(fakeCalls()).toEqual([]);
  });
});

describe('hidden reader', () => {
  const read = (input: string) => spawnSync(process.execPath, ['-e', HIDDEN_READER_SOURCE, 'P: '], { input, encoding: 'utf8' });

  it('passes the first line on stdout alone, and fails without one', () => {
    expect(HIDDEN_READER_SOURCE).not.toMatch(/["\n]/);
    expect(read(`${TOKEN}\nsecond\n`)).toMatchObject({ status: 0, stdout: TOKEN, stderr: 'P: \n' });
    expect(read('')).toMatchObject({ status: 1, stdout: '' });
  });
});

describe('wrapper reader drift', () => {
  it('keeps the token shape, size cap, id rule and store path identical in scripts/moe-account-lease.mjs', async () => {
    const lease = await import(new URL('../../../../scripts/moe-account-lease.mjs', import.meta.url).href);
    expect([lease.VM_TOKEN_RE.source, lease.VM_TOKEN_RE.flags, lease.MAX_VM_TOKEN_BYTES, lease.ACCOUNT_ID_RE.source])
      .toEqual([VM_TOKEN_RE.source, VM_TOKEN_RE.flags, MAX_VM_TOKEN_BYTES, ACCOUNT_ID_RE.source]);
    expect(lease.vmTokenPath({ MOE_ACCOUNTS_FILE: file }, 'acct-1')).toBe(vmTokenFile(file, 'acct-1'));
    expect(lease.vmTokenPath({ MOE_ACCOUNTS_FILE: file }, '../x')).toBeNull();
  });
});
