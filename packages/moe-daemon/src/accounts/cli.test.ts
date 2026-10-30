import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runAccountsCli } from './cli.js';
import { accountEnv, claudeCommand, signInStateOf } from './claudeAuth.js';
import { accountConfigDir, readRegistry } from './registry.js';

// The `accounts` CLI against a fake claude (MOE_CLAUDE_BIN): the real claude is
// never run here, and no real Claude config directory is touched. The fake
// keeps its "login" as a marker file in the CLAUDE_CONFIG_DIR it was given and
// logs each call, so a test can see which folder and which variables it got.

const FAKE_CLAUDE = `
import fs from 'fs';
import path from 'path';
const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR;
const marker = dir ? path.join(dir, 'fake-login.json') : null;
const watched = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
  args, configDir: dir ?? null, leaked: watched.filter((name) => name in process.env),
}) + '\\n');
const command = args.join(' ');
if (command === 'auth login --claudeai') {
  if (process.env.FAKE_LOGIN_EXIT !== '1') {
    fs.writeFileSync(marker, JSON.stringify({ authMethod: process.env.FAKE_AUTH_METHOD || 'claude.ai' }));
  }
  process.exit(Number(process.env.FAKE_LOGIN_EXIT || 0));
}
if (command === 'auth status --json') {
  if (!marker || !fs.existsSync(marker)) {
    process.stdout.write(JSON.stringify({ loggedIn: false }));
    process.exit(1);
  }
  const { authMethod } = JSON.parse(fs.readFileSync(marker, 'utf8'));
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod, email: 'someone@example.com', orgName: 'Example Org' }));
  process.exit(0);
}
if (command === 'auth logout') {
  if (!process.env.FAKE_LOGOUT_NOOP) fs.rmSync(marker, { force: true });
  process.exit(0);
}
process.stderr.write('fake claude: unexpected ' + command + '\\n');
process.exit(64);
`;

let dir: string;
let file: string;
let logFile: string;
let baseEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-accounts-cli-'));
  file = path.join(dir, 'claude-accounts.json');
  logFile = path.join(dir, 'fake-claude.log');
  const fake = path.join(dir, 'fake-claude.mjs');
  fs.writeFileSync(fake, FAKE_CLAUDE);
  baseEnv = {
    ...process.env,
    MOE_ACCOUNTS_FILE: file,
    MOE_CLAUDE_BIN: fake,
    FAKE_CLAUDE_LOG: logFile,
    // Each would outrank (or bypass) the account folder's login if it reached claude.
    ANTHROPIC_API_KEY: 'sk-ant-test',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CONFIG_DIR: path.join(dir, 'not-this-one'),
  };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function cli(argv: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runAccountsCli(argv, { out: (line) => out.push(line), err: (line) => err.push(line), env: { ...baseEnv, ...extraEnv } });
  return { code, out, err, all: [...out, ...err].join('\n') };
}

function fakeCalls(): Array<{ args: string[]; configDir: string | null; leaked: string[] }> {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function account(id: string) {
  return readRegistry(file)!.accounts.find((entry) => entry.id === id)!;
}

describe('accounts CLI', { timeout: 30_000 }, () => {
  it('adds and lists accounts', () => {
    const added = cli(['add', '--label', 'Work Max']);
    expect(added.code).toBe(0);
    expect(added.out).toEqual(['acct-1']);
    expect(added.err.join('\n')).toContain('login acct-1');
    expect(cli(['add']).out).toEqual(['acct-2']);
    expect(cli(['list']).out).toEqual([
      ['acct-1', 'Work Max', 'signed_out', accountConfigDir(file, 'acct-1')].join('\t'),
      ['acct-2', 'acct-2', 'signed_out', accountConfigDir(file, 'acct-2')].join('\t'),
    ]);
    expect(fakeCalls()).toEqual([]);
  });

  it('signs in with the subscription login, in the account folder, without the variables that outrank it', () => {
    cli(['add']);
    const result = cli(['login', 'acct-1']);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(['Signed in: acct-1 uses a Claude subscription. Moe can use it now.']);
    expect(account('acct-1').signIn).toBe('subscription');
    expect(account('acct-1').signInCheckedAt).not.toBeNull();
    const folder = accountConfigDir(file, 'acct-1');
    expect(fakeCalls()).toEqual([
      { args: ['auth', 'login', '--claudeai'], configDir: folder, leaked: [] },
      { args: ['auth', 'status', '--json'], configDir: folder, leaked: [] },
    ]);
    // Only the exit code and authMethod are used: nothing else claude printed comes out.
    expect(result.all).not.toContain('someone@example.com');
    expect(result.all).not.toContain('Example Org');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('someone@example.com');
  });

  it('refuses a login that is not a Claude subscription', () => {
    cli(['add']);
    const result = cli(['login', 'acct-1'], { FAKE_AUTH_METHOD: 'console' });
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('MOE_ACCOUNT_NOT_SUBSCRIPTION: acct-1 is signed in, but not with a Claude subscription');
    expect(account('acct-1').signIn).toBe('other');
  });

  it('reports a failed login and records the account as signed out', () => {
    cli(['add', '--label', 'Spare']);
    const result = cli(['login', 'acct-1'], { FAKE_LOGIN_EXIT: '1' });
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('MOE_ACCOUNT_LOGIN_FAILED: Spare (acct-1) is not signed in (claude auth login exited with 1; sign-in check: signed_out)');
    expect(account('acct-1').signIn).toBe('signed_out');
    expect(account('acct-1').signInCheckedAt).not.toBeNull();
  });

  it('signs out, and fails when claude leaves the account signed in', () => {
    cli(['add']);
    cli(['login', 'acct-1']);
    const stuck = cli(['logout', 'acct-1'], { FAKE_LOGOUT_NOOP: '1' });
    expect(stuck.code).toBe(1);
    expect(stuck.err).toEqual(['MOE_ACCOUNT_LOGOUT_FAILED: acct-1 is still signed in (sign-in check: subscription).']);
    expect(account('acct-1').signIn).toBe('subscription');
    const result = cli(['logout', 'acct-1']);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(['Signed out: acct-1.']);
    expect(account('acct-1').signIn).toBe('signed_out');
  });

  it('checks every account and exits 0 only when all are on a subscription', () => {
    cli(['add']);
    cli(['add', '--label', 'Two']);
    cli(['login', 'acct-1']);
    const all = cli(['check']);
    expect(all.code).toBe(1);
    expect(all.out).toEqual(['acct-1\tacct-1\tsubscription', 'acct-2\tTwo\tsigned_out']);
    expect(account('acct-2').signInCheckedAt).not.toBeNull();
    expect(cli(['check', 'acct-1']).code).toBe(0);
  });

  it('removes an account, signing it out first with --sign-out, and keeps its folder', () => {
    cli(['add']);
    cli(['add']);
    cli(['login', 'acct-1']);
    const stuck = cli(['remove', 'acct-1', '--sign-out'], { FAKE_LOGOUT_NOOP: '1' });
    expect(stuck.code).toBe(1);
    expect(readRegistry(file)!.accounts.map((entry) => entry.id)).toEqual(['acct-1', 'acct-2']);

    const result = cli(['remove', 'acct-1', '--sign-out']);
    expect(result.code).toBe(0);
    expect(result.out.join('\n')).toContain(accountConfigDir(file, 'acct-1'));
    expect(readRegistry(file)!.accounts.map((entry) => entry.id)).toEqual(['acct-2']);
    expect(fs.existsSync(accountConfigDir(file, 'acct-1'))).toBe(true);
    expect(fakeCalls().filter((call) => call.args.join(' ') === 'auth logout')).toHaveLength(2);

    // A plain remove never runs claude.
    const before = fakeCalls().length;
    expect(cli(['remove', 'acct-2']).code).toBe(0);
    expect(fakeCalls()).toHaveLength(before);
  });

  it('takes the list from --accounts-file, in both spellings', () => {
    const other = path.join(dir, 'other', 'accounts.json');
    expect(cli(['add', `--accounts-file=${other}`]).code).toBe(0);
    expect(readRegistry(other)!.accounts.map((entry) => entry.id)).toEqual(['acct-1']);
    expect(readRegistry(file)).toBeNull();
    expect(cli(['list', '--accounts-file', other]).out[0]).toMatch(/^acct-1\t/);
  });

  it('names unknown accounts and usage mistakes', () => {
    const unknown = cli(['login', 'acct-9']);
    expect(unknown.code).toBe(1);
    expect(unknown.err[0]).toMatch(/^MOE_ACCOUNT_UNKNOWN: /);
    const usage = (argv: string[], message: string) => {
      const result = cli(argv);
      expect(result.code).toBe(2);
      expect(result.err[0]).toBe(`accounts: ${message}`);
    };
    usage(['frobnicate'], 'unknown command "frobnicate"');
    usage(['login'], 'give the account id, for example acct-1');
    usage(['add', '--label'], '--label needs a value');
    usage(['list', '--bogus'], 'unknown option --bogus');
    expect(cli([]).code).toBe(2);
    expect(cli(['help']).code).toBe(0);
    expect(fakeCalls()).toEqual([]);
  });

  it('says when claude cannot be found, and leaves the recorded sign-in alone', () => {
    cli(['add']);
    // An inherited PATH can contain inaccessible directories (for example in
    // WSL), causing execvp to report EACCES for a name that does not exist.
    // This owned absolute path makes the missing-binary fixture deterministic.
    const missingBin = path.join(dir, 'moe-no-such-claude-binary');
    const missing = { MOE_CLAUDE_BIN: missingBin };
    const check = cli(['check'], missing);
    expect(check.code).toBe(1);
    expect(check.err.join('\n')).toContain(`MOE_CLAUDE_NOT_FOUND: could not run "${missingBin}"`);
    expect(account('acct-1').signInCheckedAt).toBeNull();
    expect(cli(['login', 'acct-1'], missing).err.join('\n')).toContain('MOE_CLAUDE_NOT_FOUND');
    expect(account('acct-1').signInCheckedAt).toBeNull();
  });
});

describe('claude process setup', () => {
  it('runs a .mjs fake under this node, and claude from PATH elsewhere', () => {
    expect(claudeCommand({ MOE_CLAUDE_BIN: '/x/fake.mjs' }, 'win32')).toEqual({ file: process.execPath, prefix: ['/x/fake.mjs'], shell: false, missing: false });
    expect(claudeCommand({}, 'linux')).toEqual({ file: 'claude', prefix: [], shell: false, missing: false });
  });

  it.runIf(process.platform === 'win32')('finds claude on the Windows PATH first, so a missing one is never read as signed out', () => {
    const npmDir = path.join(dir, 'npm');
    const nativeDir = path.join(dir, 'native');
    fs.mkdirSync(npmDir);
    fs.mkdirSync(nativeDir);
    fs.writeFileSync(path.join(npmDir, 'claude'), '');
    fs.writeFileSync(path.join(npmDir, 'claude.cmd'), '');
    fs.writeFileSync(path.join(nativeDir, 'claude.exe'), '');
    const env = (pathValue: string, extra: NodeJS.ProcessEnv = {}) => ({ Path: pathValue, PATHEXT: '.COM;.EXE;.BAT;.CMD', ...extra });
    // The extension comes from PATHEXT; Windows file names ignore case.
    expect(claudeCommand(env(`${npmDir};${nativeDir}`), 'win32')).toEqual({ file: path.join(npmDir, 'claude.CMD'), prefix: [], shell: true, missing: false });
    expect(claudeCommand(env(`"${nativeDir}";${npmDir}`), 'win32')).toEqual({ file: path.join(nativeDir, 'claude.EXE'), prefix: [], shell: false, missing: false });
    expect(claudeCommand(env(path.join(dir, 'empty')), 'win32')).toMatchObject({ missing: true });
    const exe = path.join(nativeDir, 'claude.exe');
    expect(claudeCommand(env('', { MOE_CLAUDE_BIN: exe }), 'win32')).toEqual({ file: exe, prefix: [], shell: false, missing: false });
  });

  it('drops the credentials and provider switches that outrank a login, every spelling on Windows', () => {
    const base = { PATH: 'p', ANTHROPIC_API_KEY: 'k', anthropic_auth_token: 't', Claude_Code_Use_Vertex: '1', CLAUDE_CONFIG_DIR: 'old' };
    expect(accountEnv(base, '/acct', 'win32')).toEqual({ PATH: 'p', CLAUDE_CONFIG_DIR: '/acct' });
    expect(accountEnv(base, '/acct', 'linux')).toEqual({ PATH: 'p', anthropic_auth_token: 't', Claude_Code_Use_Vertex: '1', CLAUDE_CONFIG_DIR: '/acct' });
  });

  it('reads only the exit code and authMethod', () => {
    const run = (status: number | null, stdout = '', notFound = false) => signInStateOf({ status, stdout, notFound });
    expect(run(0, '{"authMethod":"claude.ai","email":"x@example.com"}')).toBe('subscription');
    expect(run(0, '{"authMethod":"console"}')).toBe('other');
    expect(run(0, '{}')).toBe('other');
    expect(run(1, '{"authMethod":"claude.ai"}')).toBe('signed_out');
    expect(run(0, 'not json')).toBe('unknown');
    expect(run(0, 'null')).toBe('unknown');
    expect(run(null)).toBe('unknown');
    expect(run(null, '', true)).toBe('unknown');
  });
});
