// scripts/moe-account-lease.mjs: the wrapper side of Claude account rotation.
// Every case uses temp directories and a fake claude written here. Nothing in
// this file runs the real claude or opens a real Claude config directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PROVIDER_ENV,
  RENEW_ARGS,
  RENEW_PROMPT,
  TOKEN_ENV,
  VM_CREDENTIAL_REASONS,
  accountEnv,
  claudeCommand,
  findWindowsCommand,
  formatStatus,
  gateLine,
  localConfigDir,
  pickLine,
  probeCommand,
  readSignInCredential,
  renewEnv,
  resolveVmCredential,
  launchInside,
  signInStateOf,
  statuslineSample,
  statuslineSettingsJson,
  trustKeys,
  trustLine,
  writeSample,
} from '../moe-account-lease.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELPER = path.join(ROOT, 'scripts', 'moe-account-lease.mjs');
const ROTATION_ENV = ['MOE_ACCOUNT_ROTATION', 'MOE_ACCOUNT_RETRY_SEC', 'MOE_ACCOUNT_ID', 'MOE_ACCOUNT_SAMPLE_FILE', 'CLAUDE_CONFIG_DIR',
  ...TOKEN_ENV, ...PROVIDER_ENV];

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-account-lease-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of ROTATION_ENV) delete env[name];
  return { ...env, ...extra };
}

function helper(args, { env = cleanEnv(), input = '' } = {}) {
  return spawnSync(process.execPath, [HELPER, ...args], { env, input, encoding: 'utf8' });
}

// A fake claude: logs what it was started with (never a token value) and
// answers `auth status --json` like claude does, plus fields Moe must drop.
function fakeClaude(t) {
  const dir = tempDir(t);
  const bin = path.join(dir, 'fake-claude.mjs');
  const log = path.join(dir, 'claude.log');
  fs.writeFileSync(bin, [
    "import fs from 'node:fs';",
    'const env = process.env;',
    'fs.appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), configDir: env.CLAUDE_CONFIG_DIR ?? null,',
    '  token: env.CLAUDE_CODE_OAUTH_TOKEN ?? null, apiKey: env.ANTHROPIC_API_KEY ?? null, bedrock: env.CLAUDE_CODE_USE_BEDROCK ?? null }) + "\\n");',
    "if (env.FAKE_SILENT !== '1') console.log(JSON.stringify({ loggedIn: env.FAKE_EXIT !== '1', authMethod: env.FAKE_AUTH ?? 'claude.ai',",
    "  email: 'someone@example.com', orgName: 'Secret Org' }));",
    "process.exit(Number(env.FAKE_EXIT ?? 0));",
  ].join('\n'));
  const entries = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  return { dir, bin, log, entries };
}

test('importing the helper runs no command', () => {
  assert.equal(process.exitCode, undefined);
});

test('retry-sec: shared account wait policy without credentials or side effects', () => {
  for (const [value, expected] of [['', '300'], ['1', '1'], ['17', '17'], ['0', '300'], ['bad', '300']]) {
    const out = helper(['retry-sec'], { env: cleanEnv({ MOE_ACCOUNT_RETRY_SEC: value }) });
    assert.deepEqual([out.status, out.stdout, out.stderr], [0, expected + '\n', '']);
  }
});

test('gate: on by default, off on request, skipped under a cloud provider', () => {
  assert.equal(gateLine({}), 'go');
  for (const value of ['0', 'false', 'OFF', 'no', ' off ']) assert.equal(gateLine({ MOE_ACCOUNT_ROTATION: value }), 'off', value);
  assert.equal(gateLine({ MOE_ACCOUNT_ROTATION: 'on' }), 'go');
  assert.equal(gateLine({ CLAUDE_CODE_USE_VERTEX: '1' }),
    'skip\tMOE_ACCOUNT_SKIPPED: CLAUDE_CODE_USE_VERTEX is set, so claude does not use claude.ai logins; launching without rotation.');
  assert.equal(gateLine({ CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_FOUNDRY: '' }), 'go');
  assert.equal(gateLine({ MOE_ACCOUNT_ROTATION: 'off', CLAUDE_CODE_USE_BEDROCK: '1' }), 'off');
  assert.equal(helper(['gate']).stdout, 'go\n');
  assert.equal(helper(['gate'], { env: cleanEnv({ MOE_ACCOUNT_ROTATION: 'off' }) }).stdout, 'off\n');
});

test('pick: a leased account becomes id, peak and a local config directory', () => {
  const leased = { rotation: true, accountId: 'acct-1', label: 'Work', configDir: '/home/u/.moe/claude-accounts/acct-1', peakPercent: 42.46, switchAtPercent: 90 };
  assert.equal(pickLine(JSON.stringify(leased), {}, 'linux'), 'leased\tacct-1\t42.5\t/home/u/.moe/claude-accounts/acct-1');
  assert.equal(pickLine(JSON.stringify({ ...leased, peakPercent: null }), {}, 'linux'), 'leased\tacct-1\t?\t/home/u/.moe/claude-accounts/acct-1');
  // A Windows daemon serving a WSL wrapper ("Run Agents in WSL").
  const windows = { ...leased, configDir: 'C:\\Users\\u\\.moe\\claude-accounts\\acct-1' };
  assert.equal(pickLine(JSON.stringify(windows), {}, 'linux'), 'leased\tacct-1\t42.5\t/mnt/c/Users/u/.moe/claude-accounts/acct-1');
  assert.equal(pickLine(JSON.stringify(windows), {}, 'win32'), 'leased\tacct-1\t42.5\tC:\\Users\\u\\.moe\\claude-accounts\\acct-1');
  assert.equal(pickLine(JSON.stringify({ ...leased, configDir: 'relative/acct-1' }), {}, 'linux'), 'unavailable\tno usable config directory for acct-1');
  assert.equal(pickLine(JSON.stringify({ ...leased, configDir: '/a\tb' }), {}, 'linux'), 'unavailable\tno usable config directory for acct-1');
  assert.equal(pickLine(JSON.stringify({ ...leased, configDir: undefined }), {}, 'linux'), 'unavailable\tno usable config directory for acct-1');
  assert.equal(pickLine(JSON.stringify({ ...leased, accountId: 'bad id' }), {}, 'linux'), 'unavailable\tunreadable reply from the daemon');
});

test('pick: spent accounts wait (capped), rotation off carries the reason, anything else is unavailable', () => {
  const spent = { rotation: true, accountId: null, retryAt: '2026-10-20T13:00:00.000Z', retryInSec: 3540, switchAtPercent: 90 };
  assert.equal(pickLine(JSON.stringify(spent), {}), 'wait\t300\t2026-10-20T13:00:00.000Z');
  assert.equal(pickLine(JSON.stringify({ ...spent, retryInSec: 12.2 }), { MOE_ACCOUNT_RETRY_SEC: '60' }), 'wait\t13\t2026-10-20T13:00:00.000Z');
  assert.equal(pickLine(JSON.stringify({ ...spent, retryInSec: 0 }), {}), 'wait\t1\t2026-10-20T13:00:00.000Z');
  assert.equal(pickLine(JSON.stringify({ ...spent, retryInSec: 900 }), { MOE_ACCOUNT_RETRY_SEC: 'soon' }), 'wait\t300\t2026-10-20T13:00:00.000Z');
  assert.equal(pickLine(JSON.stringify({ ...spent, retryAt: undefined }), {}), 'wait\t300\t?');
  assert.equal(pickLine(JSON.stringify({ ...spent, retryInSec: 'x' }), {}), 'unavailable\tunreadable reply from the daemon');
  assert.equal(pickLine(JSON.stringify({ rotation: false, reason: null }), {}), 'off\t');
  assert.equal(pickLine(JSON.stringify({ rotation: false, reason: 'none of the 2 Claude accounts is signed in\twith a subscription\n(Moe tool window > Accounts > Sign in)' }), {}),
    'off\tMOE_ACCOUNT_SKIPPED: none of the 2 Claude accounts is signed in with a subscription (Moe tool window > Accounts > Sign in); launching without rotation.');
  assert.equal(pickLine('', {}), 'unavailable\tno reply from the daemon');
  for (const text of ['not json', '[]', 'null', '{"accountId":"acct-1"}']) assert.equal(pickLine(text, {}), 'unavailable\tunreadable reply from the daemon', text);
  // The wrappers pipe the reply in on stdin.
  const reply = JSON.stringify({ rotation: true, accountId: 'acct-2', label: 'acct-2', configDir: path.resolve(os.tmpdir(), 'acct-2'), peakPercent: 7, switchAtPercent: 90 });
  assert.equal(helper(['pick'], { input: reply }).stdout, `leased\tacct-2\t7\t${path.resolve(os.tmpdir(), 'acct-2')}\n`);
  assert.equal(helper(['pick']).stdout, 'unavailable\tno reply from the daemon\n');
});

test('localConfigDir follows TerminalAgentLauncher.toWslPath', () => {
  assert.equal(localConfigDir('D:\\projexts\\moes', 'linux'), '/mnt/d/projexts/moes');
  assert.equal(localConfigDir('d:/a/b/', 'linux'), '/mnt/d/a/b/');
  assert.equal(localConfigDir('C:', 'linux'), '/mnt/c');
  assert.equal(localConfigDir('C:\\', 'darwin'), '/mnt/c');
  assert.equal(localConfigDir('/home/u/acct', 'linux'), '/home/u/acct');
  assert.equal(localConfigDir('\\\\server\\share\\acct', 'linux'), '\\\\server\\share\\acct');
  assert.equal(localConfigDir('C:\\Users\\u', 'win32'), 'C:\\Users\\u');
});

test('accountEnv binds claude to the account and drops every variable that outranks or bypasses its login', () => {
  const parent = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o',
    CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CONFIG_DIR: '/elsewhere', KEEP: '1' };
  assert.deepEqual(accountEnv(parent, '/acct', 'linux'), { PATH: '/bin', KEEP: '1', CLAUDE_CONFIG_DIR: '/acct' });
  assert.equal(parent.ANTHROPIC_API_KEY, 'sk');
  assert.equal(parent.CLAUDE_CONFIG_DIR, '/elsewhere');
  assert.deepEqual(accountEnv({ Path: 'p', Anthropic_Api_Key: 'x', claude_config_dir: 'old' }, 'C:\\acct', 'win32'), { Path: 'p', CLAUDE_CONFIG_DIR: 'C:\\acct' });
  assert.deepEqual(accountEnv({ anthropic_api_key: 'x' }, '/acct', 'linux'), { anthropic_api_key: 'x', CLAUDE_CONFIG_DIR: '/acct' });
});

test('signInStateOf reads the exit code and authMethod, and a failure without claude JSON is unknown', () => {
  assert.equal(signInStateOf({ status: 0, stdout: '{"authMethod":"claude.ai","email":"a@b.c"}\n' }), 'subscription');
  assert.equal(signInStateOf({ status: 0, stdout: '{"authMethod":"api_key"}' }), 'other');
  assert.equal(signInStateOf({ status: 0, stdout: '{}' }), 'other');
  assert.equal(signInStateOf({ status: 1, stdout: '{"loggedIn":false,"authMethod":"none"}' }), 'signed_out');
  // cmd.exe's "not recognized" exit, a rejected flag, a crash: claude printed no JSON.
  assert.equal(signInStateOf({ status: 1, stdout: '' }), 'unknown');
  assert.equal(signInStateOf({ status: 1, stdout: 'error: unknown option --bogus' }), 'unknown');
  assert.equal(signInStateOf({ status: 9009, stdout: '' }), 'unknown');
  for (const stdout of ['not json', '[]', 'null', '"claude.ai"']) assert.equal(signInStateOf({ status: 0, stdout }), 'unknown', stdout);
  assert.equal(signInStateOf({ status: null, stdout: '' }), 'unknown');
  assert.equal(signInStateOf({ status: 1, stdout: '{}', notFound: true }), 'unknown');
  assert.equal(signInStateOf(undefined), 'unknown');
});

// Windows file names are case-insensitive; the resolver returns PATHEXT's spelling.
const windowsFiles = (...names) => (file) => names.some((name) => name.toLowerCase() === file.toLowerCase());

test('findWindowsCommand searches PATH x PATHEXT, never the current directory', () => {
  const exists = windowsFiles('C:\\b c\\claude.cmd', 'C:\\tools\\claude.exe', 'claude.cmd', 'C:\\x\\claude.exe');
  assert.equal(findWindowsCommand('claude', { Path: 'C:\\a; "C:\\b c" ;', PathExt: '.EXE;.CMD' }, exists), 'C:\\b c\\claude.CMD');
  assert.equal(findWindowsCommand('claude', { PATH: 'C:\\a;C:\\x' }, exists), 'C:\\x\\claude.EXE');
  assert.equal(findWindowsCommand('claude', { PATH: '' }, exists), null, 'claude.cmd in the current directory is never run');
  assert.equal(findWindowsCommand('claude', {}, exists), null);
  assert.equal(findWindowsCommand('C:\\tools\\claude', { PATH: 'C:\\b c' }, exists), 'C:\\tools\\claude.EXE');
  assert.equal(findWindowsCommand('C:\\tools\\claude.exe', {}, exists), 'C:\\tools\\claude.exe');
  assert.equal(findWindowsCommand('C:\\tools\\missing', { PATH: 'C:\\b c' }, exists), null);
});

test('probeCommand runs a resolved claude, never a missing one through cmd.exe', () => {
  const exists = windowsFiles('C:\\n\\claude.exe', 'C:\\Program Files\\n\\claude.cmd');
  const probe = ['auth', 'status', '--json'];
  assert.equal(probeCommand(['claude'], { PATH: 'C:\\empty' }, 'win32', exists), null);
  assert.deepEqual(probeCommand(['claude', '--verbose'], { PATH: 'C:\\n' }, 'win32', exists),
    { file: 'C:\\n\\claude.EXE', args: ['--verbose', ...probe], shell: false });
  assert.deepEqual(probeCommand(['claude', '--model', 'a b'], { PATH: 'C:\\Program Files\\n' }, 'win32', exists),
    { file: '"C:\\Program Files\\n\\claude.CMD" --model "a b" auth status --json', args: [], shell: true });
  for (const word of ['%USERPROFILE%', 'say "hi"', 'bang!', 'two\nlines']) {
    assert.equal(probeCommand(['claude', word], { PATH: 'C:\\Program Files\\n' }, 'win32', exists), null, word);
  }
  assert.deepEqual(probeCommand(['claude', '-x'], {}, 'linux', exists), { file: 'claude', args: ['-x', ...probe], shell: false });
  assert.equal(probeCommand(['/nowhere/fake.mjs'], {}, 'linux', exists), null);
  assert.deepEqual(probeCommand(['C:\\n\\claude.exe'], {}, 'win32', exists), { file: 'C:\\n\\claude.exe', args: probe, shell: false });
  assert.equal(probeCommand([], {}, 'linux', exists), null);
});

test('signin-state probes the account directory and prints only the state', (t) => {
  const fake = fakeClaude(t);
  const accountDir = path.join(tempDir(t), 'claude-accounts', 'acct-1');
  const env = cleanEnv({
    FAKE_CLAUDE_LOG: fake.log, CLAUDE_CODE_OAUTH_TOKEN: 'must-not-reach-claude', ANTHROPIC_API_KEY: 'sk-not-real',
    CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CONFIG_DIR: path.join(fake.dir, 'operator-config'),
  });
  const run = (extra = {}) => helper(['signin-state', accountDir, fake.bin, '--model', 'opus'], { env: { ...env, ...extra } });
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'subscription\n');
  assert.equal(run({ FAKE_AUTH: 'api_key' }).stdout, 'other\n');
  assert.equal(run({ FAKE_EXIT: '1', FAKE_AUTH: 'none' }).stdout, 'signed_out\n');
  assert.equal(run({ FAKE_EXIT: '1', FAKE_SILENT: '1' }).stdout, 'unknown\n');
  const calls = fake.entries();
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.deepEqual(call, { args: ['--model', 'opus', 'auth', 'status', '--json'], configDir: accountDir, token: null, apiKey: null, bedrock: null });
  }
  assert.doesNotMatch(ok.stdout + ok.stderr, /example\.com|Secret Org/);
});

test('signin-state is unknown when claude cannot be found, and says so without running anything', (t) => {
  const dir = tempDir(t);
  const accountDir = path.join(dir, 'acct-1');
  const missing = helper(['signin-state', accountDir, path.join(dir, 'no-such-claude')]);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout, 'unknown\n');
  const notOnPath = helper(['signin-state', accountDir, 'moe-no-such-claude-7f3c'], { env: cleanEnv({ PATH: dir }) });
  assert.equal(notOnPath.stdout, 'unknown\n');
  assert.equal(helper(['signin-state', accountDir, path.join(dir, 'missing.mjs')]).stdout, 'unknown\n');
  const bare = helper(['signin-state', accountDir]);
  assert.equal(bare.status, 2);
  assert.equal(bare.stdout, 'unknown\n');
  assert.equal(fs.existsSync(accountDir), false, 'the probe never creates the account directory');
});

test('signin-state runs an npm-style claude.cmd through cmd.exe', { skip: process.platform !== 'win32' && 'Windows only' }, (t) => {
  const bin = path.join(tempDir(t), 'npm global');
  fs.mkdirSync(bin);
  const cmd = path.join(bin, 'claude.cmd');
  const write = (exit) => fs.writeFileSync(cmd, `@echo off\r\necho {"authMethod":"claude.ai","email":"someone@example.com"}\r\nexit /b ${exit}\r\n`);
  const env = cleanEnv({ PATH: `${bin};${process.env.SystemRoot}\\System32` });
  write(0);
  assert.equal(helper(['signin-state', 'C:\\acct-1', 'claude'], { env }).stdout, 'subscription\n');
  write(1);
  assert.equal(helper(['signin-state', 'C:\\acct-1', 'claude'], { env }).stdout, 'signed_out\n');
  fs.rmSync(cmd);
  assert.equal(helper(['signin-state', 'C:\\acct-1', 'claude'], { env }).stdout, 'unknown\n');
});

test('statusline prints the account and usage, and writes the sample for the wrapper', (t) => {
  const sample = path.join(tempDir(t), 'sample.json');
  const input = JSON.stringify({
    model: { display_name: 'Opus' },
    rate_limits: { five_hour: { used_percentage: 42.4, resets_at: 1792462800 }, seven_day: { used_percentage: 63 } },
  });
  const out = helper(['statusline'], { env: cleanEnv({ MOE_ACCOUNT_ID: 'acct-1', MOE_ACCOUNT_SAMPLE_FILE: sample }), input });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, 'Opus | acct-1 | 5h 42% | 7d 63%\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(sample, 'utf8')), {
    accountId: 'acct-1',
    windows: { five_hour: { percent: 42.4, resetsAt: 1792462800 }, seven_day: { percent: 63 } },
    refused: false,
  });
  fs.rmSync(sample);
  const garbage = helper(['statusline'], { env: cleanEnv({ MOE_ACCOUNT_ID: 'acct-1', MOE_ACCOUNT_SAMPLE_FILE: sample }), input: '{oops' });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, 'claude | acct-1\n');
  const badId = helper(['statusline'], { env: cleanEnv({ MOE_ACCOUNT_ID: 'bad id', MOE_ACCOUNT_SAMPLE_FILE: sample }), input });
  assert.equal(badId.stdout, 'Opus | no account | 5h 42% | 7d 63%\n');
  assert.equal(fs.existsSync(sample), false, 'no sample without a valid account id');
});

// The statusline runs once per refresh, each time a new process: a temp file a
// failed rename left (the ps1 wrapper reading the sample) was never removed.
test('writeSample leaves no temp file behind when the rename fails', (t) => {
  const dir = tempDir(t);
  const sample = path.join(dir, 'sample.json');
  fs.mkdirSync(path.join(sample, 'held'), { recursive: true });
  assert.throws(() => writeSample(sample, { accountId: 'acct-1', windows: {}, refused: false }));
  assert.deepEqual(fs.readdirSync(dir), ['sample.json']);
});

test('statuslineSample keeps valid windows only, at most eight', () => {
  const limits = { five_hour: { used_percentage: 10, resets_at: 1 }, 'Bad-Name': { used_percentage: 1 }, seven_day: { used_percentage: '9' },
    spend_limit: { used_percentage: 101.5, resets_at: null } };
  assert.deepEqual(statuslineSample({ rate_limits: limits }), { five_hour: { percent: 10, resetsAt: 1 }, spend_limit: { percent: 101.5 } });
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`w${i}`, { used_percentage: i }]));
  assert.equal(Object.keys(statuslineSample({ rate_limits: many })).length, 8);
  assert.deepEqual(statuslineSample(null), {});
  assert.deepEqual(statuslineSample({ rate_limits: [] }), {});
  assert.equal(formatStatus({}, '', {}), 'claude | no account');
});

test('statusline-settings writes a --settings file whose statusLine runs this helper', (t) => {
  const file = path.join(tempDir(t), 'settings.json');
  const out = helper(['statusline-settings', file]);
  assert.equal(out.status, 0, out.stderr);
  const { statusLine } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(statusLine.type, 'command');
  assert.match(statusLine.command, /moe-account-lease\.mjs' statusline$/);
  assert.equal(helper(['statusline-settings']).status, 2);
  assert.equal(statuslineSettingsJson('C:\\node\\node.exe', 'C:\\moe\\scripts\\moe-account-lease.mjs', 'win32'),
    JSON.stringify({ statusLine: { type: 'command', command: "node 'C:/moe/scripts/moe-account-lease.mjs' statusline" } }));
  assert.equal(statuslineSettingsJson('node', "C:\\it's\\moe-account-lease.mjs", 'win32'), null);
  assert.equal(statuslineSettingsJson('/usr/bin/node', "/it's/moe-account-lease.mjs", 'linux'),
    JSON.stringify({ statusLine: { type: 'command', command: "'/usr/bin/node' '/it'\\''s/moe-account-lease.mjs' statusline" } }));
});

// One-shot seats get their sample from the bash launcher's stream-json parser,
// run here as moe-agent.sh runs it (the ps1 twin parses in PowerShell).
const PYTHON = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['-c', 'import sys; sys.exit(sys.version_info[0] != 3)']).status === 0);

test('the bash stream parser writes the leased account sample from rate_limit_event', { skip: !PYTHON && 'no python 3' }, (t) => {
  const text = fs.readFileSync(path.join(ROOT, 'scripts', 'moe-agent.sh'), 'utf8').replaceAll('\r\n', '\n');
  const open = "STREAM_JSON_PARSER=$(cat <<'PYEOF'\n";
  const start = text.indexOf(open);
  assert.ok(start > 0, 'STREAM_JSON_PARSER not found in moe-agent.sh');
  const parser = text.slice(start + open.length, text.indexOf('\nPYEOF', start));
  const events = [
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1792462800,
      unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1792462800 }, seven_day: { utilization: 0.1 }, odd: { utilization: true } } } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1792900000 } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day' } },
  ];
  const input = `${events.map((event) => JSON.stringify(event)).join('\n')}\nplain line\n`;
  const run = (env) => spawnSync(PYTHON, ['-I', '-u', '-c', parser], { input, encoding: 'utf8', env: cleanEnv(env) });
  const sample = path.join(tempDir(t), 'sample.json');
  const out = run({ MOE_ACCOUNT_ID: 'acct-1', MOE_ACCOUNT_SAMPLE_FILE: sample });
  assert.equal(out.status, 0, out.stderr);
  // Windows python writes CRLF to a text-mode stdout.
  assert.match(out.stdout.replaceAll('\r\n', '\n'), /\[rate-limit rejected seven_day\]\n[^]*plain line\n$/);
  // A refusal stays on the sample for the rest of the run.
  assert.deepEqual(JSON.parse(fs.readFileSync(sample, 'utf8')), {
    accountId: 'acct-1',
    windows: {
      five_hour: { utilization: 0.42, resetsAt: 1792462800, status: 'allowed' },
      seven_day: { utilization: 0.1, status: 'allowed', resetsAt: 1792900000 },
    },
    refused: true,
  });
  const unleased = path.join(tempDir(t), 'unleased.json');
  assert.equal(run({ MOE_ACCOUNT_SAMPLE_FILE: unleased }).status, 0);
  assert.equal(fs.existsSync(unleased), false, 'no sample without a leased account');
});

test('an unknown command prints usage and fails', () => {
  const out = helper(['offer']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /^usage: node moe-account-lease\.mjs gate \| pick/);
});

// --- trust: an interactive seat's folder trust in the leased account's
// .claude.json. Every config here is a temp file seeded by the test.
const SECRET = 'moe-secret-marker-5f1c';
const MiB16 = 16 * 1024 * 1024;
const noGit = { gitTop: () => null };
// The key claude's trust dialog writes for a directory (no git repo here).
const keyOf = (dir) => (process.platform === 'win32' ? dir.replaceAll('\\', '/') : dir);
const canSymlink = process.platform !== 'win32' || (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-symlink-probe-'));
  try {
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'));
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return false;
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// A real, canonical directory, so the default realpath adds no second key.
const realTemp = (t) => fs.realpathSync.native(tempDir(t));

function seedConfig(configDir, config, mode = 0o600) {
  const file = path.join(configDir, '.claude.json');
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config, null, 2), { mode });
  if (process.platform !== 'win32') fs.chmodSync(file, mode);
  return file;
}

const untrustedSeed = (key) => ({
  numStartups: 3,
  hasCompletedOnboarding: true,
  oauthAccount: { emailAddress: `${SECRET}@example.com`, organizationName: SECRET },
  projects: {
    '/elsewhere/trusted': { allowedTools: ['Bash'], hasTrustDialogAccepted: true },
    [key]: { allowedTools: [], hasTrustDialogAccepted: false, mcpServers: { local: { command: 'x' } } },
  },
  userID: 'u-1',
});

test('trustKeys: the given, real and git top-level directories, one form each', () => {
  assert.deepEqual(trustKeys('/a/b/', { platform: 'linux', realpath: () => '/real/b', gitTop: () => '/a' }), ['/a/b', '/real/b', '/a']);
  assert.deepEqual(trustKeys('/a/b', { platform: 'linux', realpath: () => '/a/b/', gitTop: () => '/a/b' }), ['/a/b']);
  const fail = () => { throw new Error('no'); };
  assert.deepEqual(trustKeys('/a/b', { platform: 'linux', realpath: fail, gitTop: () => null }), ['/a/b']);
  assert.deepEqual(trustKeys('/a/b', { platform: 'linux', realpath: () => '', gitTop: fail }), ['/a/b']);
  const same = (dir) => dir;
  assert.deepEqual(trustKeys('D:\\projexts\\moes\\', { platform: 'win32', realpath: same, gitTop: () => 'D:/projexts/moes' }), ['D:/projexts/moes']);
  assert.deepEqual(trustKeys('d:\\x', { platform: 'win32', realpath: same, gitTop: () => null }), ['d:/x', 'D:/x']);
  assert.deepEqual(trustKeys('D:\\', { platform: 'win32', realpath: same, gitTop: () => null }), ['D:/']);
  assert.deepEqual(trustKeys('C:\\w\\repo\\sub', { platform: 'win32', realpath: same, gitTop: () => 'C:/w/repo' }), ['C:/w/repo/sub', 'C:/w/repo']);
});

const HAS_GIT = spawnSync('git', ['--version']).status === 0;

test('trustKeys: by default a nested directory also gets its git top-level, the key claude writes', { skip: !HAS_GIT && 'no git' }, (t) => {
  const repo = realTemp(t);
  const sub = path.join(repo, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(trustKeys(sub).filter((key) => key.toLowerCase() !== keyOf(sub).toLowerCase()).map((key) => key.toLowerCase()),
    [keyOf(repo).toLowerCase()]);
  assert.deepEqual(trustKeys(repo, { realpath: () => null }).map((key) => key.toLowerCase()), [keyOf(repo).toLowerCase()]);
});

test('launchInside: the project itself or below it, case-insensitive on Windows', () => {
  assert.equal(launchInside('/x/proj', '/x/proj', 'linux'), true);
  assert.equal(launchInside('/x/proj/', '/x/proj/a/b', 'linux'), true);
  assert.equal(launchInside('/x/proj', '/x/proj-other', 'linux'), false);
  assert.equal(launchInside('/x/proj', '/x', 'linux'), false);
  assert.equal(launchInside('/x/proj', '/x/Proj', 'linux'), false);
  assert.equal(launchInside('/x/proj', '/x/proj/..foo', 'linux'), true);
  assert.equal(launchInside('D:\\Proj', 'd:\\proj\\sub', 'win32'), true);
  assert.equal(launchInside('D:\\proj', 'D:\\proj2', 'win32'), false);
  assert.equal(launchInside('D:\\proj', 'E:\\proj', 'win32'), false);
});

test('trust: an untrusted config is granted under the lock; nothing else in it changes', (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  const key = keyOf(project);
  assert.deepEqual(trustKeys(project, noGit), [key], 'fixture: one key for a canonical temp dir');
  const seed = untrustedSeed(key);
  const file = seedConfig(configDir, seed, 0o660);
  fs.writeFileSync(path.join(configDir, '.credentials.json'), SECRET);
  assert.equal(trustLine(configDir, project, project, noGit), 'granted');
  const text = fs.readFileSync(file, 'utf8');
  const after = JSON.parse(text);
  assert.equal(text, JSON.stringify(after, null, 2), '2-space JSON, no trailing newline');
  assert.deepEqual(after.projects[key], { ...seed.projects[key], hasTrustDialogAccepted: true }, 'the entry keeps its fields');
  const rest = (config) => ({ ...config, projects: { ...config.projects, [key]: null } });
  assert.deepEqual(rest(after), rest(seed));
  assert.deepEqual(Object.keys(after), Object.keys(seed), 'key order kept');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o660, 'file mode kept');
  assert.deepEqual(fs.readdirSync(configDir).sort(), ['.claude.json', '.credentials.json'], 'no lock or temp file left');
  assert.equal(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8'), SECRET);
  assert.equal(trustLine(configDir, project, project, noGit), 'trusted');
});

test('trust: a config without projects gets the minimal entry claude writes', (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  const file = seedConfig(configDir, { numStartups: 1 });
  assert.equal(trustLine(configDir, project, project, noGit), 'granted');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { numStartups: 1, projects: { [keyOf(project)]: { hasTrustDialogAccepted: true } } });
  const garbage = seedConfig(configDir, { projects: { [keyOf(project)]: 'not an object', other: { hasTrustDialogAccepted: true } } });
  assert.equal(trustLine(configDir, project, project, noGit), 'granted');
  assert.deepEqual(JSON.parse(fs.readFileSync(garbage, 'utf8')).projects,
    { [keyOf(project)]: { hasTrustDialogAccepted: true }, other: { hasTrustDialogAccepted: true } });
});

test('trust: every key must be trusted, and only the missing ones are written', (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  const top = path.dirname(project);
  const opts = { gitTop: () => top };
  const keys = trustKeys(project, opts);
  assert.deepEqual(keys, [keyOf(project), keyOf(top)]);
  const file = seedConfig(configDir, { projects: { [keys[0]]: { hasTrustDialogAccepted: true, a: 1 } } });
  assert.equal(trustLine(configDir, project, project, opts), 'granted');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects,
    { [keys[0]]: { hasTrustDialogAccepted: true, a: 1 }, [keys[1]]: { hasTrustDialogAccepted: true } });
});

test('trust: an already trusted config is left byte-for-byte alone', (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  const file = seedConfig(configDir, `${JSON.stringify({ projects: { [keyOf(project)]: { hasTrustDialogAccepted: true } } })}\n`);
  const before = fs.readFileSync(file);
  const { mtimeMs } = fs.statSync(file);
  assert.equal(trustLine(configDir, project, project, noGit), 'trusted');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, mtimeMs);
  assert.deepEqual(fs.readdirSync(configDir), ['.claude.json']);
});

test('trust: a missing config is refused and nothing is created', (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  const env = { MOE_ACCOUNT_RETRY_SEC: '5' };
  assert.equal(trustLine(configDir, project, project, { ...noGit, env }), 'refused\t5\tno .claude.json in the account folder');
  assert.deepEqual(fs.readdirSync(configDir), []);
  const absent = path.join(configDir, 'acct-9');
  assert.equal(trustLine(absent, project, project, { ...noGit, env: {} }), 'refused\t300\tno .claude.json in the account folder');
  assert.equal(fs.existsSync(absent), false);
});

test('trust: a config that is not a JSON object is refused and left alone', (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  for (const text of [`{"oauthAccount":"${SECRET}"`, '[]', 'null', '"x"', '{"projects":[]}', '{"projects":"x"}', '{"projects":null}', '\ufeff{}']) {
    const file = seedConfig(configDir, text);
    assert.equal(trustLine(configDir, project, project, { ...noGit, env: {} }),
      "refused\t300\tthe account's .claude.json is not a JSON object", text);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  assert.deepEqual(fs.readdirSync(configDir), ['.claude.json']);
});

test('trust: a config over 16 MiB is refused', (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  const file = seedConfig(configDir, '{}');
  fs.truncateSync(file, MiB16 + 1);
  assert.equal(trustLine(configDir, project, project, { ...noGit, env: {} }), "refused\t300\tthe account's .claude.json is over 16 MiB");
  fs.truncateSync(file, MiB16);
  assert.equal(trustLine(configDir, project, project, { ...noGit, env: {} }), "refused\t300\tthe account's .claude.json is not a JSON object",
    'exactly 16 MiB is read (and is not JSON here)');
  assert.equal(fs.statSync(file).size, MiB16);
});

test('trust: a config that is not a regular file is refused', { skip: !canSymlink && 'no symlinks on this host' }, (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  const target = path.join(tempDir(t), 'real.json');
  fs.writeFileSync(target, JSON.stringify({ projects: {} }));
  const link = path.join(configDir, '.claude.json');
  fs.symlinkSync(target, link);
  assert.equal(trustLine(configDir, project, project, { ...noGit, env: {} }), "refused\t300\tthe account's .claude.json is not a regular file");
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link stays');
  assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify({ projects: {} }));
  fs.rmSync(link);
  fs.mkdirSync(link);
  assert.equal(trustLine(configDir, project, project, { ...noGit, env: {} }), "refused\t300\tthe account's .claude.json is not a regular file");
});

test("trust: claude's lock held by someone else is waited on, then refused, and never removed", (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  const file = seedConfig(configDir, untrustedSeed(keyOf(project)));
  const before = fs.readFileSync(file);
  const lock = path.join(configDir, '.claude.json.lock');
  fs.mkdirSync(lock);
  const started = Date.now();
  assert.equal(trustLine(configDir, project, project, { ...noGit, env: {}, lockWaitMs: 200 }),
    "refused\t300\tthe account's .claude.json is locked by another claude");
  const waited = Date.now() - started;
  assert.ok(waited >= 150 && waited < 3000, `waited ${waited} ms for a 200 ms lock wait`);
  assert.ok(fs.statSync(lock).isDirectory(), 'the foreign lock stays');
  assert.deepEqual(fs.readFileSync(file), before);
  fs.rmdirSync(lock);
  assert.equal(trustLine(configDir, project, project, { ...noGit, lockWaitMs: 200 }), 'granted');
});

// claude's lock library (proper-lockfile) refreshes a held lock's mtime every 5 s
// and takes over one whose mtime is more than 10 s old: a killed holder's lock.
test("trust: claude's lock left stale by a killed holder is taken over, by claude's own 10 s rule", (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  const file = seedConfig(configDir, untrustedSeed(keyOf(project)));
  const lock = path.join(configDir, '.claude.json.lock');
  fs.mkdirSync(lock);
  const age = (sec) => {
    const when = new Date(Date.now() - sec * 1000);
    fs.utimesSync(lock, when, when);
  };
  age(5);
  assert.equal(trustLine(configDir, project, project, { ...noGit, env: {}, lockWaitMs: 100 }),
    "refused\t300\tthe account's .claude.json is locked by another claude");
  assert.ok(fs.statSync(lock).isDirectory(), 'a lock its holder still refreshes stays');
  age(11);
  assert.equal(trustLine(configDir, project, project, { ...noGit, env: {}, lockWaitMs: 100 }), 'granted');
  assert.equal(fs.existsSync(lock), false, 'the lock taken over is released like this call\'s own');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects[keyOf(project)].hasTrustDialogAccepted, true);
});

test('trust: a stale lock path that is not a folder is never removed', (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  seedConfig(configDir, untrustedSeed(keyOf(project)));
  const lock = path.join(configDir, '.claude.json.lock');
  fs.writeFileSync(lock, '');
  const when = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, when, when);
  assert.equal(trustLine(configDir, project, project, { ...noGit, env: {}, lockWaitMs: 100 }),
    "refused\t300\tthe account's .claude.json is locked by another claude");
  assert.ok(fs.statSync(lock).isFile(), 'not a lock claude made: it stays');
});

test('trust: a config that does not parse unlocked is read again under the lock (claude may be mid-save)', (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  const file = seedConfig(configDir, '{"numStartups":');
  fs.mkdirSync(path.join(configDir, '.claude.json.lock'));
  assert.equal(trustLine(configDir, project, project, { ...noGit, env: {}, lockWaitMs: 100 }),
    "refused\t300\tthe account's .claude.json is locked by another claude");
  assert.equal(fs.readFileSync(file, 'utf8'), '{"numStartups":');
});

test('trust: a key found set on the locked re-read is reported trusted, and nothing is written', (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  const file = seedConfig(configDir, '{"numStartups":');
  const lock = path.join(configDir, '.claude.json.lock');
  fs.mkdirSync(lock);
  // claude finishes its save and releases the lock while the helper waits for it.
  const finished = JSON.stringify(trustedFor(project));
  const child = spawn(process.execPath, ['-e', `setTimeout(() => { require('fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(finished)}); require('fs').rmdirSync(${JSON.stringify(lock)}); }, 150)`]);
  t.after(() => child.kill());
  assert.equal(trustLine(configDir, project, project, { ...noGit, lockWaitMs: 5000 }), 'trusted');
  assert.equal(fs.readFileSync(file, 'utf8'), finished);
  assert.deepEqual(fs.readdirSync(configDir), ['.claude.json']);
});

test('trust: a folder it cannot write in is refused, the config unchanged',
  { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions as a non-root user' }, (t) => {
    const project = realTemp(t);
    const configDir = tempDir(t);
    const file = seedConfig(configDir, untrustedSeed(keyOf(project)));
    const before = fs.readFileSync(file);
    fs.chmodSync(configDir, 0o555);
    try {
      assert.equal(trustLine(configDir, project, project, { ...noGit, env: {} }), "refused\t300\tthe account's .claude.json could not be rewritten");
    } finally {
      fs.chmodSync(configDir, 0o755);
    }
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(configDir), ['.claude.json']);
  });

test('trust: the launch directory must be the project or inside it', (t) => {
  const base = realTemp(t);
  const project = path.join(base, 'proj');
  const sibling = path.join(base, 'proj-other');
  const sub = path.join(project, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(sibling);
  const configDir = tempDir(t);
  const file = seedConfig(configDir, untrustedSeed(keyOf(project)));
  const before = fs.readFileSync(file);
  for (const outside of [sibling, base]) {
    assert.equal(trustLine(configDir, project, outside, { ...noGit, env: {} }), 'refused\t300\tthe launch directory is outside the project', outside);
  }
  assert.deepEqual(fs.readFileSync(file), before);
  seedConfig(configDir, { projects: { [keyOf(sibling)]: { hasTrustDialogAccepted: true } } });
  assert.equal(trustLine(configDir, project, sibling, noGit), 'trusted', 'an outside directory that is already trusted launches');
  assert.equal(trustLine(configDir, project, sub, noGit), 'granted');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects[keyOf(sub)].hasTrustDialogAccepted, true);
});

test('trust CLI: one line, the retry seconds, nothing from the config, usage on missing arguments', (t) => {
  const project = realTemp(t);
  const configDir = tempDir(t);
  const missing = helper(['trust', configDir, project], { env: cleanEnv({ MOE_ACCOUNT_RETRY_SEC: '7' }) });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout, 'refused\t7\tno .claude.json in the account folder\n');
  assert.equal(helper(['trust', configDir, project], { env: cleanEnv({ MOE_ACCOUNT_RETRY_SEC: 'soon' }) }).stdout,
    'refused\t300\tno .claude.json in the account folder\n');
  assert.equal(helper(['trust', configDir, project], { env: cleanEnv({ MOE_ACCOUNT_RETRY_SEC: '0' }) }).stdout,
    'refused\t300\tno .claude.json in the account folder\n');
  seedConfig(configDir, `{"oauthAccount":{"emailAddress":"${SECRET}"`);
  const broken = helper(['trust', configDir, project]);
  assert.equal(broken.stdout, "refused\t300\tthe account's .claude.json is not a JSON object\n");
  const file = seedConfig(configDir, untrustedSeed(keyOf(project)));
  const granted = helper(['trust', configDir, project, project]);
  assert.equal(granted.status, 0, granted.stderr);
  assert.equal(granted.stdout, 'granted\n');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects[keyOf(project)].hasTrustDialogAccepted, true);
  const again = helper(['trust', configDir, project]);
  assert.equal(again.stdout, 'trusted\n');
  for (const run of [missing, broken, granted, again]) {
    assert.equal(run.stderr, '');
    assert.doesNotMatch(run.stdout, new RegExp(SECRET));
  }
  for (const args of [['trust'], ['trust', configDir]]) {
    const bare = helper(args);
    assert.equal(bare.status, 2);
    assert.equal(bare.stdout, '');
    assert.match(bare.stderr, /trust <configDir> <projectDir> \[<launchDir>\]/);
  }
});

// --- The launchers' real lease loops (moe-agent.sh get_account_lease, moe-agent.ps1
// Get-MoeAccountLease), cut out of the wrappers and run against this helper with
// a scripted daemon. sleep/Start-Sleep only record; chat_send is logged.
const launcherSource = (ext) => fs.readFileSync(path.join(ROOT, 'scripts', `moe-agent.${ext}`), 'utf8').replaceAll('\r\n', '\n');
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing boundaries: ${start} / ${end}`);
  return source.slice(from, to);
}
const LEASE_ENGINES = process.platform === 'win32'
  ? [['ps1', 'powershell.exe'], ['ps1', 'pwsh.exe'], ['sh', 'C:/Program Files/Git/bin/bash.exe']]
  : [['sh', '/bin/bash']];
const shQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const fwd = (file) => file.replaceAll('\\', '/');

function shLeaseScript(fx) {
  const block = between(launcherSource('sh'), '# printf, not echo -e: a reason from the daemon is printed as is.', "# Runs inside the CLI's subshell");
  return [
    'set -e',
    `WORKER_ID=worker-trust PROJECT=${shQuote(fx.project)} GENERAL_CHANNEL_ID=chan-general`,
    `NODE_CMD=${shQuote(fwd(process.execPath))} PYTHON_CMD=${PYTHON} ACCOUNT_HELPER=${shQuote(fwd(fx.helper))}`,
    `CLAUDE_INTERACTIVE=${fx.interactive ? 'true' : 'false'} YELLOW='' GREEN='' NC=''`,
    `ACCOUNT_SAMPLE_FILE=${shQuote(fwd(path.join(fx.dir, 'sample.json')))}`,
    'ACCOUNT_LEASED_ID="" ACCOUNT_LEASED_DIR="" ACCOUNT_PREV_ID="" ACCOUNT_SAMPLE_SENT="" ACCOUNT_ARGS=()',
    // A command substitution runs moe_rpc in a subshell: count leases in the log.
    'moe_rpc() {',
    '    printf \'%s\\t%s\\n\' "$1" "$2" >> "$RPC_LOG"',
    '    [ "$1" = lease_account ] || return 0',
    '    local n line',
    '    n=$(grep -c "^lease_account" "$RPC_LOG")',
    '    line=$(sed -n "${n}p" "$REPLIES")',
    '    printf \'%s\' "${line:-{\\"rotation\\":false,\\"reason\\":null\\}}"',
    '}',
    'sleep() { printf \'%s\\n\' "$1" >> "$SLEEP_LOG"; }',
    // get_account_lease sleeps through the real idle_wait (d94c095f), which calls the stub above.
    between(launcherSource('sh'), '# An externally killed idle/backoff sleep must not end the seat under set -e', '# moe_rpc TOOL ARGS_JSON'),
    block,
    'get_account_lease',
    'printf \'LEASED=%s\\n\' "$ACCOUNT_LEASED_ID"',
  ].join('\n');
}

function ps1LeaseScript(fx) {
  const source = launcherSource('ps1');
  const block = between(source, "# One line from moe-account-lease.mjs ('' when it printed nothing)", '# The values never leave this process');
  const chat = between(source, 'function Send-MoeGeneralChat([string]$Content) {', 'function ConvertTo-MoeRecordPaths');
  return [
    '\ufeff$ErrorActionPreference = \'Stop\'',
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$utf8 = [Text.UTF8Encoding]::new($false)',
    'function Invoke-MoeRpc {',
    '    param([Parameter(Mandatory = $true)][string]$Tool, [object]$Args)',
    '    [IO.File]::AppendAllText($env:RPC_LOG, "$Tool`t$($Args | ConvertTo-Json -Compress -Depth 5)`n", $utf8)',
    "    if ($Tool -ne 'lease_account') { return $null }",
    "    $n = @([IO.File]::ReadAllLines($env:RPC_LOG) | Where-Object { $_ -like \"lease_account`t*\" }).Count",
    '    $replies = @([IO.File]::ReadAllLines($env:REPLIES) | Where-Object { $_ })',
    "    if ($n -le $replies.Count) { return ($replies[$n - 1] | ConvertFrom-Json) }",
    "    return ('{\"rotation\":false,\"reason\":null}' | ConvertFrom-Json)",
    '}',
    'function Start-Sleep { param([int]$Seconds) [IO.File]::AppendAllText($env:SLEEP_LOG, "$Seconds`n", $utf8) }',
    `$WorkerId = 'worker-trust'; $projectPath = ${psQuote(fx.project)}; $generalChannelId = 'chan-general'`,
    `$accountHelper = ${psQuote(fx.helper)}; $claudeInteractive = $${fx.interactive ? 'true' : 'false'}`,
    `$script:AccountSampleFile = ${psQuote(path.join(fx.dir, 'sample.json'))}`,
    "$script:AccountLeasedId = ''; $script:AccountLeasedDir = ''; $script:AccountPrevId = ''; $script:AccountSampleSent = ''",
    '$script:AccountWindows = [ordered]@{}; $script:AccountSampleRefused = $false; $accountArgs = @()',
    chat,
    block,
    'Set-Location -LiteralPath $env:LAUNCH_DIR',
    'Get-MoeAccountLease',
    'Write-Output "LEASED=$($script:AccountLeasedId)"',
  ].join('\n');
}

// One lease loop. accounts: the folder of each lease reply, in order (then rotation off).
function runLeaseLoop(t, ext, engine, { accounts, interactive = true, launch = null, configs = {}, helper = HELPER }) {
  const dir = realTemp(t);
  const home = path.join(dir, 'acct-home');
  const project = path.join(dir, 'proj');
  fs.mkdirSync(path.join(project, 'sub'), { recursive: true });
  for (const id of ['acct-1', 'acct-2']) {
    fs.mkdirSync(path.join(home, id), { recursive: true });
    if (configs[id] !== undefined) seedConfig(path.join(home, id), configs[id](project));
  }
  const fx = { dir, project, helper, interactive };
  const replies = accounts.map((id) => JSON.stringify({ rotation: true, accountId: id, label: id, configDir: path.join(home, id), peakPercent: 10 }));
  const files = { RPC_LOG: path.join(dir, 'rpc.log'), REPLIES: path.join(dir, 'replies.jsonl'), SLEEP_LOG: path.join(dir, 'sleep.log') };
  fs.writeFileSync(files.REPLIES, `${replies.join('\n')}\n`);
  const script = path.join(dir, `lease.${ext}`);
  fs.writeFileSync(script, ext === 'ps1' ? ps1LeaseScript(fx) : shLeaseScript(fx));
  const env = cleanEnv({ MOE_ACCOUNT_RETRY_SEC: '3', LAUNCH_DIR: launch ? launch(project) : project,
    ...Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fwd(file)])) });
  const result = spawnSync(engine, ext === 'ps1' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] : [fwd(script)],
    { encoding: 'utf8', timeout: 60_000, env });
  assert.ifError(result.error);
  const out = result.stdout.replaceAll('\r\n', '\n');
  assert.equal(result.status, 0, out + result.stderr);
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
  const rpcs = read(files.RPC_LOG).map((line) => [line.slice(0, line.indexOf('\t')), line.slice(line.indexOf('\t') + 1)]);
  return {
    out, project, home,
    leased: /^LEASED=(.*)$/m.exec(out)?.[1],
    leases: rpcs.filter(([tool]) => tool === 'lease_account').length,
    chats: rpcs.filter(([tool]) => tool === 'chat_send').map(([, args]) => JSON.parse(args)),
    sleeps: read(files.SLEEP_LOG),
    config: (id) => path.join(home, id, '.claude.json'),
  };
}

const untrustedFor = (project) => untrustedSeed(keyOf(project));
const trustedFor = (project) => ({ projects: { [keyOf(project)]: { hasTrustDialogAccepted: true } } });
const isTrustedIn = (file, dir) => JSON.parse(fs.readFileSync(file, 'utf8')).projects?.[keyOf(dir)]?.hasTrustDialogAccepted === true;
const untrustedLine = (id, project, reason) => `[account] MOE_ACCOUNT_UNTRUSTED account=${id} project=${project} (${reason}) - `
  + "not launching into Claude's folder-trust dialog; retry in 3s, the held task stays held. (Ctrl+C to stop)";

for (const [ext, engine] of LEASE_ENGINES) {
  const skip = ext === 'sh' && !PYTHON && 'no python 3';

  test(`${engine}: an interactive seat on an untrusted account is granted trust, then launches`, { skip }, (t) => {
    const run = runLeaseLoop(t, ext, engine, { accounts: ['acct-1'], configs: { 'acct-1': untrustedFor } });
    assert.match(run.out, /\[account\] MOE_ACCOUNT_LEASED account=acct-1 usage=10%/);
    assert.ok(run.out.includes(`[account] MOE_ACCOUNT_TRUST_GRANTED account=acct-1 project=${run.project}\n`), run.out);
    assert.equal(isTrustedIn(run.config('acct-1'), run.project), true);
    assert.equal(run.leased, 'acct-1');
    assert.equal(run.leases, 1);
    assert.deepEqual(run.chats, []);
    assert.deepEqual(run.sleeps, []);
  });

  test(`${engine}: an interactive seat on a trusted account launches and writes nothing`, { skip }, (t) => {
    const run = runLeaseLoop(t, ext, engine, { accounts: ['acct-1'], configs: { 'acct-1': trustedFor } });
    assert.doesNotMatch(run.out, /MOE_ACCOUNT_TRUST|MOE_ACCOUNT_UNTRUSTED/);
    assert.equal(fs.readFileSync(run.config('acct-1'), 'utf8'), JSON.stringify(trustedFor(run.project), null, 2));
    assert.equal(run.leased, 'acct-1');
  });

  test(`${engine}: an account that cannot be trusted is refused loudly, then the next one is leased`, { skip }, (t) => {
    const run = runLeaseLoop(t, ext, engine, { accounts: ['acct-1', 'acct-2'], configs: { 'acct-2': untrustedFor } });
    assert.ok(run.out.includes(`${untrustedLine('acct-1', run.project, 'no .claude.json in the account folder')}\n`), run.out);
    assert.equal(run.chats.length, 1, 'one #general escalation');
    const [chat] = run.chats;
    assert.equal(chat.channel, 'chan-general');
    assert.equal(chat.workerId, 'worker-trust');
    assert.equal(chat.content, `@governors worker-trust: MOE_ACCOUNT_UNTRUSTED - account acct-1 does not trust project ${run.project} `
      + "and Moe could not grant it (no .claude.json in the account folder). The interactive seat waits instead of parking at Claude's "
      + `folder-trust dialog. Fix: start claude once in ${run.project} under that account's folder (claude-accounts/acct-1) and accept the trust dialog.`);
    assert.ok(!chat.content.includes(run.home) && !chat.content.includes(fwd(run.home)), 'no account folder reaches the daemon');
    assert.deepEqual(run.sleeps, ['3']);
    assert.equal(run.leases, 2);
    assert.match(run.out, /MOE_ACCOUNT_SWITCHED from=acct-1 to=acct-2/);
    assert.ok(run.out.includes(`[account] MOE_ACCOUNT_TRUST_GRANTED account=acct-2 project=${run.project}\n`), run.out);
    assert.equal(isTrustedIn(run.config('acct-2'), run.project), true);
    assert.equal(run.leased, 'acct-2');
    assert.deepEqual(fs.readdirSync(path.join(run.home, 'acct-1')), [], "nothing is created in acct-1's folder");
  });

  test(`${engine}: the same account refused twice escalates once per lease loop`, { skip }, (t) => {
    const run = runLeaseLoop(t, ext, engine, { accounts: ['acct-1', 'acct-1'] });
    assert.equal(run.out.split('MOE_ACCOUNT_UNTRUSTED account=acct-1').length - 1, 2, run.out);
    assert.equal(run.chats.length, 1);
    assert.deepEqual(run.sleeps, ['3', '3']);
    assert.equal(run.leases, 3);
    assert.equal(run.leased, '', 'rotation off after the scripted replies: launches unrotated');
  });

  test(`${engine}: a headless seat never opens the account's config`, { skip }, (t) => {
    const run = runLeaseLoop(t, ext, engine, { accounts: ['acct-1'], interactive: false, configs: { 'acct-1': untrustedFor } });
    assert.doesNotMatch(run.out, /MOE_ACCOUNT_TRUST|MOE_ACCOUNT_UNTRUSTED/);
    assert.equal(fs.readFileSync(run.config('acct-1'), 'utf8'), JSON.stringify(untrustedFor(run.project), null, 2));
    assert.equal(run.leased, 'acct-1');
  });

  test(`${engine}: a trust helper that fails launches unrotated`, { skip }, (t) => {
    const fake = path.join(realTemp(t), 'failing-trust.mjs');
    fs.writeFileSync(fake, [
      `import { main } from ${JSON.stringify(pathToFileURL(HELPER).href)};`,
      "if (process.argv[2] === 'trust') process.exit(1);",
      'process.exitCode = main(process.argv.slice(2));',
    ].join('\n'));
    const run = runLeaseLoop(t, ext, engine, { accounts: ['acct-1'], configs: { 'acct-1': untrustedFor }, helper: fake });
    assert.match(run.out, /\[account\] MOE_ACCOUNT_LEASED account=acct-1/);
    assert.ok(run.out.includes('[account] MOE_ACCOUNT_LEASE_UNAVAILABLE (the account helper failed) - launching without rotation.\n'), run.out);
    assert.equal(run.leased, '');
    assert.deepEqual(run.chats, []);
    assert.deepEqual(run.sleeps, []);
    assert.equal(isTrustedIn(run.config('acct-1'), run.project), false);
  });

  if (ext === 'ps1') {
    test(`${engine}: the trust key follows the launch location, which must be inside the project`, (t) => {
      const outside = runLeaseLoop(t, ext, engine, { accounts: ['acct-1'], configs: { 'acct-1': untrustedFor }, launch: (project) => path.dirname(project) });
      assert.ok(outside.out.includes(`${untrustedLine('acct-1', outside.project, 'the launch directory is outside the project')}\n`), outside.out);
      assert.equal(outside.chats.length, 1);
      assert.equal(outside.leased, '');
      const inside = runLeaseLoop(t, ext, engine, { accounts: ['acct-1'], configs: { 'acct-1': untrustedFor }, launch: (project) => path.join(project, 'sub') });
      assert.ok(inside.out.includes(`[account] MOE_ACCOUNT_TRUST_GRANTED account=acct-1 project=${inside.project}\n`), inside.out);
      assert.equal(isTrustedIn(inside.config('acct-1'), path.join(inside.project, 'sub')), true);
      assert.equal(inside.leased, 'acct-1');
    });
  }
}

test('vm-credential: exactly the stored token on stdout, else nothing and exit 3', (t) => {
  const dir = tempDir(t);
  const token = `sk-ant-oat01-${'Q7x_Lm2-Zp9K'.repeat(4)}`;
  const store = path.join(dir, 'claude-vm-tokens');
  const put = (id, content) => fs.writeFileSync(path.join(store, `${id}.token`), content);
  fs.mkdirSync(store);
  put('acct-1', token);
  put('big', 'a'.repeat(1101));
  put('api', `sk-ant-api03-${'b'.repeat(40)}`);
  put('newline', `${token}\n`);
  fs.mkdirSync(path.join(store, 'folder.token'));
  fs.writeFileSync(path.join(dir, 'acct-1.token'), token); // where '../acct-1' would land
  const ids = ['missing', 'big', 'api', 'newline', 'folder', '../acct-1'];
  const linked = path.join(dir, 'linked');
  fs.mkdirSync(linked);
  try {
    fs.symlinkSync(path.join(store, 'acct-1.token'), path.join(store, 'link.token'));
    fs.symlinkSync(store, path.join(linked, 'claude-vm-tokens'), 'dir');
    ids.push('link');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
  }
  const run = (args, accountsDir = dir) => {
    const { status, stdout, stderr } = helper(args, { env: cleanEnv({ MOE_ACCOUNTS_FILE: path.join(accountsDir, 'claude-accounts.json') }) });
    return { status, stdout, stderr };
  };
  assert.deepEqual(run(['vm-credential', 'acct-1']), { status: 0, stdout: token, stderr: '' });
  const unavailable = { status: 3, stdout: '', stderr: 'MOE_VM_TOKEN_UNAVAILABLE\n' };
  for (const id of ids) assert.deepEqual(run(['vm-credential', id]), unavailable, id);
  if (ids.includes('link')) assert.deepEqual(run(['vm-credential', 'acct-1'], linked), unavailable, 'symlinked store');
  assert.deepEqual([run(['vm-credential']).status, run(['vm-credential']).stdout], [2, '']);
});

// --- vm-credential from the account's host sign-in. Canaries only: no real
// token, account folder or claude. Every folder is <tmp>/claude-accounts/<id>.
const ACCESS = `sk-ant-oat01-ACCESSCANARY_${'a1B2'.repeat(6)}`;
const REFRESH = `sk-ant-ort01-REFRESHCANARY_${'r9Z8'.repeat(6)}`;
const RENEWED = `sk-ant-oat01-RENEWEDCANARY_${'n5M6'.repeat(6)}`;
const RENEWED_REFRESH = `sk-ant-ort01-RENEWEDREFRESH_${'q3W4'.repeat(6)}`;
const CANARIES = [ACCESS, REFRESH, RENEWED, RENEWED_REFRESH];
const HOUR_MS = 3_600_000;

/** claude's .credentials.json shape, with the fields Moe must never pass on. */
function signInJson({ token = ACCESS, expiresAt = Date.now() + 2 * HOUR_MS, scopes = ['user:inference', 'user:profile'], refresh = REFRESH } = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: token, refreshToken: refresh, expiresAt, refreshTokenExpiresAt: Date.now() + 720 * HOUR_MS, scopes,
      subscriptionType: 'max', subscriptionTypeSource: 'canary', rateLimitTier: 'canary_tier',
    },
  });
}

/** An account folder holding `content` (string) as .credentials.json, or no file for null. */
function accountFolder(t, id = 'acct-1', content = signInJson()) {
  const home = tempDir(t);
  const configDir = path.join(home, 'claude-accounts', id);
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, '.credentials.json');
  if (content !== null) fs.writeFileSync(file, content);
  return { home, configDir, file };
}

/** The file's bytes and mtime, to prove the helper never wrote it. */
function fileState(file) {
  try {
    return { bytes: fs.readFileSync(file, 'utf8'), mtimeMs: fs.statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

function assertNoRefresh(value, label) {
  const text = JSON.stringify(value ?? null);
  for (const canary of [REFRESH, RENEWED_REFRESH]) assert.ok(!text.includes(canary), `refresh token leaked: ${label}`);
}

test('readSignInCredential returns only the access token and its expiry, read-only', (t) => {
  const expiresAt = Date.now() + 2 * HOUR_MS;
  const { configDir, file } = accountFolder(t, 'acct-1', signInJson({ expiresAt }));
  const before = fileState(file);
  const result = readSignInCredential(configDir, 'acct-1');
  assert.deepEqual(result, { token: ACCESS, expiresAt });
  assert.deepEqual(fileState(file), before);
  assertNoRefresh(result, 'valid');
  // A trailing separator names the same folder; exactly 64 KiB is still read.
  assert.deepEqual(readSignInCredential(configDir + path.sep, 'acct-1'), { token: ACCESS, expiresAt });
  const padded = signInJson({ expiresAt });
  fs.writeFileSync(file, padded + ' '.repeat(65536 - Buffer.byteLength(padded)));
  assert.deepEqual(readSignInCredential(configDir, 'acct-1'), { token: ACCESS, expiresAt });
});

test('readSignInCredential: no-signin-file for every missing, foreign, odd or oversized file', (t) => {
  const rows = [];
  const missing = accountFolder(t, 'acct-1', null);
  fs.rmSync(missing.configDir, { recursive: true });
  rows.push(['missing folder', missing.configDir, 'acct-1', null]);
  const empty = accountFolder(t, 'acct-1', null);
  rows.push(['folder without the file', empty.configDir, 'acct-1', null]);
  const other = accountFolder(t, 'acct-2');
  rows.push(["another id's folder", other.configDir, 'acct-1', other.file]);
  rows.push(['a bad id', other.configDir, '../acct-2', other.file]);
  rows.push(['no folder', '', 'acct-1', null]);
  const folderFile = accountFolder(t, 'acct-1', null);
  fs.mkdirSync(folderFile.file);
  rows.push(['the file is a directory', folderFile.configDir, 'acct-1', null]);
  const big = signInJson();
  const huge = accountFolder(t, 'acct-1', big + ' '.repeat(65537 - Buffer.byteLength(big)));
  rows.push(['65537 bytes', huge.configDir, 'acct-1', huge.file]);
  const linked = accountFolder(t, 'acct-1', null);
  const target = path.join(linked.home, 'elsewhere.json');
  fs.writeFileSync(target, signInJson());
  try {
    fs.symlinkSync(target, linked.file);
    rows.push(['a symlinked file', linked.configDir, 'acct-1', target]);
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.diagnostic('symlink rows skipped: creating a symlink needs a privilege here');
  }
  for (const [label, configDir, id, file] of rows) {
    const before = file && fileState(file);
    const result = readSignInCredential(configDir, id);
    assert.deepEqual(result, { reason: 'no-signin-file' }, label);
    if (file) assert.deepEqual(fileState(file), before, `${label}: file untouched`);
  }
  assert.deepEqual(readSignInCredential(undefined, 'acct-1'), { reason: 'no-signin-file' });
});

test('readSignInCredential: signed-out for anything but a usable claude.ai sign-in', (t) => {
  const oauth = JSON.parse(signInJson()).claudeAiOauth;
  const without = (key) => JSON.stringify({ claudeAiOauth: { ...oauth, [key]: undefined } });
  const rows = [
    ['not JSON', '{"claudeAiOauth": {'],
    ['an empty object', '{}'],
    ['a JSON array', '[]'],
    ['claudeAiOauth not an object', JSON.stringify({ claudeAiOauth: [oauth] })],
    ['no accessToken', without('accessToken')],
    ['an API key', signInJson({ token: `sk-ant-api03-${'b'.repeat(40)}` })],
    ['a token with a newline', signInJson({ token: `${ACCESS}\n` })],
    ['expiresAt as a string', signInJson({ expiresAt: String(Date.now() + HOUR_MS) })],
    ['expiresAt past a valid Date', signInJson({ expiresAt: 1e16 })],
    ['expiresAt fractional', signInJson({ expiresAt: Date.now() + 0.5 })],
    ['no expiresAt', without('expiresAt')],
    ['scopes without user:inference', signInJson({ scopes: ['user:profile'] })],
    ['scopes not an array', signInJson({ scopes: 'user:inference' })],
  ];
  for (const [label, content] of rows) {
    const { configDir, file } = accountFolder(t, 'acct-1', content);
    const before = fileState(file);
    const result = readSignInCredential(configDir, 'acct-1');
    assert.deepEqual(result, { reason: 'signed-out' }, label);
    assert.deepEqual(fileState(file), before, `${label}: file untouched`);
    assertNoRefresh(result, label);
  }
});

const MINTED = `sk-ant-oat01-MINTEDCANARY_${'m7K8'.repeat(6)}`;
// The seat's identity, Moe's mods and every credential the renewal run must not inherit (values are never logged).
const SEAT_ENV = {
  MOE_WORKER_ID: 'worker-canary', CLAUDE_CODE_PLUGIN_DIRS: '/moe/mods', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-not-real',
  ANTHROPIC_API_KEY: 'sk-not-real', CLAUDE_CODE_USE_BEDROCK: '1',
};

// A fake claude for the renewal run, separate from fakeClaude (whose log shape
// signin-state pins). It logs the argv, cwd, stdin, CLAUDE_CONFIG_DIR and only
// the NAMES of the seat variables it can see. With FAKE_RENEW_TOKEN set it
// rewrites the sign-in the way claude's refresh does and logs the sha256 of
// what it wrote.
function fakeRenewClaude(t) {
  const dir = tempDir(t);
  const bin = path.join(dir, 'fake-renew-claude.mjs');
  const log = path.join(dir, 'renew.log');
  fs.writeFileSync(bin, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { createHash } from 'node:crypto';",
    'const env = process.env;',
    "const stdin = fs.readFileSync(0, 'utf8');",
    `const watched = ${JSON.stringify(Object.keys(SEAT_ENV))};`,
    'const seen = Object.keys(env).filter((name) => /^MOE_/i.test(name) || watched.includes(name.toUpperCase()));',
    'let wrote = null;',
    'if (env.FAKE_RENEW_TOKEN) {',
    "  const text = JSON.stringify({ claudeAiOauth: { accessToken: env.FAKE_RENEW_TOKEN, refreshToken: env.FAKE_RENEW_REFRESH,",
    "    expiresAt: Date.now() + Number(env.FAKE_RENEW_LEFT_MS || 8 * 3600000), scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } });",
    "  const file = path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json');",
    "  fs.writeFileSync(file + '.tmp', text);",
    '  fs.renameSync(file + \'.tmp\', file);',
    "  wrote = createHash('sha256').update(text).digest('hex');",
    '}',
    'fs.appendFileSync(env.FAKE_RENEW_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin,',
    "  configDir: env.CLAUDE_CONFIG_DIR ?? null, seen, wrote }) + '\\n');",
    'process.exit(Number(env.FAKE_EXIT ?? 0));',
  ].join('\n'));
  const entries = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  return { bin, log, entries };
}

/** Runs vm-credential / vm-credential-state against a temp accounts home (never the real ~/.moe). */
function vmRun(command, account, words, extra = {}) {
  const env = cleanEnv({ MOE_ACCOUNTS_FILE: path.join(account.home, 'claude-accounts.json'), ...SEAT_ENV, ...extra });
  const { status, stdout, stderr } = helper([command, 'acct-1', account.configDir, ...words], { env });
  return { status, stdout, stderr };
}

/** No credential in state output or either command's stderr, and never a refresh token in fetch stdout. */
function assertNoCredential(label, fetch, state) {
  for (const [name, text] of [['state stdout', state?.stdout], ['state stderr', state?.stderr], ['fetch stderr', fetch?.stderr]]) {
    for (const canary of [...CANARIES, MINTED]) assert.ok(!String(text ?? '').includes(canary), `${label}: a credential in ${name}`);
  }
  assertNoRefresh(fetch?.stdout ?? '', `${label}: fetch stdout`);
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const realDir = (dir) => fs.realpathSync.native(dir);

test('VM_CREDENTIAL_REASONS is the documented list', () => {
  assert.deepEqual([...VM_CREDENTIAL_REASONS], ['no-signin-file', 'signed-out', 'expired', 'no-claude']);
  assert.ok(Object.isFrozen(VM_CREDENTIAL_REASONS));
});

test('claudeCommand appends the tail under probeCommand rules, quoting the empty --tools word for cmd.exe', () => {
  const exists = windowsFiles('C:\\n\\claude.exe', 'C:\\Program Files\\n\\claude.cmd');
  assert.deepEqual(claudeCommand(['claude', '-x'], RENEW_ARGS, {}, 'linux', exists), { file: 'claude', args: ['-x', ...RENEW_ARGS], shell: false });
  assert.deepEqual(claudeCommand(['claude'], RENEW_ARGS, { PATH: 'C:\\n' }, 'win32', exists), { file: 'C:\\n\\claude.EXE', args: [...RENEW_ARGS], shell: false });
  assert.deepEqual(claudeCommand(['claude'], RENEW_ARGS, { PATH: 'C:\\Program Files\\n' }, 'win32', exists), {
    file: '"C:\\Program Files\\n\\claude.CMD" -p --model haiku --no-session-persistence --strict-mcp-config --tools ""', args: [], shell: true,
  });
  assert.equal(claudeCommand(['claude', '%TEMP%'], RENEW_ARGS, { PATH: 'C:\\Program Files\\n' }, 'win32', exists), null);
  assert.equal(claudeCommand(['/nowhere/claude.js'], RENEW_ARGS, {}, 'linux', exists), null);
  assert.deepEqual(RENEW_ARGS.slice(-2), ['--tools', '']);
});

test('renewEnv drops the seat identity, Moe mods and every login override', () => {
  const parent = { PATH: '/bin', MOE_WORKER_ID: 'w', MOE_SESSION_ID: 's', CLAUDE_CODE_PLUGIN_DIRS: '/mods', ANTHROPIC_API_KEY: 'k',
    CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CONFIG_DIR: '/old', CLAUDE_CODE_OTHER: 'keep', moe_lower: 'keep' };
  assert.deepEqual(renewEnv(parent, '/acct', 'linux'), { PATH: '/bin', CLAUDE_CODE_OTHER: 'keep', moe_lower: 'keep', CLAUDE_CONFIG_DIR: '/acct' });
  assert.equal(parent.MOE_WORKER_ID, 'w');
  assert.deepEqual(renewEnv({ Path: 'p', Moe_Worker_Id: 'w', claude_code_plugin_dirs: 'm', claude_code_oauth_token: 'o' }, 'C:\\acct', 'win32'),
    { Path: 'p', CLAUDE_CONFIG_DIR: 'C:\\acct' });
});

test('vm-credential: a stored minted token wins over the sign-in, and no claude runs', (t) => {
  const fake = fakeRenewClaude(t);
  const account = accountFolder(t, 'acct-1', 'not json');
  fs.mkdirSync(path.join(account.home, 'claude-vm-tokens'));
  fs.writeFileSync(path.join(account.home, 'claude-vm-tokens', 'acct-1.token'), MINTED);
  const fetch = vmRun('vm-credential', account, [fake.bin], { FAKE_RENEW_LOG: fake.log });
  const state = vmRun('vm-credential-state', account, [fake.bin], { FAKE_RENEW_LOG: fake.log });
  assert.deepEqual(fetch, { status: 0, stdout: MINTED, stderr: '' });
  assert.deepEqual(state, { status: 0, stdout: 'minted\n', stderr: '' });
  assert.deepEqual(fake.entries(), []);
  assertNoCredential('minted', fetch, state);
});

test('vm-credential: a sign-in with more than 5 minutes left is printed as is, read-only, without running claude', (t) => {
  const fake = fakeRenewClaude(t);
  const expiresAt = Date.now() + 2 * HOUR_MS;
  const account = accountFolder(t, 'acct-1', signInJson({ expiresAt }));
  const before = fileState(account.file);
  const fetch = vmRun('vm-credential', account, [fake.bin], { FAKE_RENEW_LOG: fake.log });
  const state = vmRun('vm-credential-state', account, [fake.bin], { FAKE_RENEW_LOG: fake.log });
  assert.deepEqual(fetch, { status: 0, stdout: ACCESS, stderr: '' });
  assert.deepEqual(state, { status: 0, stdout: `signin\t${new Date(expiresAt).toISOString()}\n`, stderr: '' });
  assert.deepEqual(fake.entries(), []);
  assert.deepEqual(fileState(account.file), before);
  assertNoCredential('valid', fetch, state);
});

test('vm-credential: 5 minutes or less left renews through exactly one scrubbed host claude run, then re-reads', (t) => {
  for (const [label, left, command] of [['60 s left', 60_000, 'vm-credential'], ['already expired', -HOUR_MS, 'vm-credential'],
    ['60 s left, state first', 60_000, 'vm-credential-state']]) {
    const fake = fakeRenewClaude(t);
    const account = accountFolder(t, 'acct-1', signInJson({ expiresAt: Date.now() + left }));
    const extra = { FAKE_RENEW_LOG: fake.log, FAKE_RENEW_TOKEN: RENEWED, FAKE_RENEW_REFRESH: RENEWED_REFRESH };
    const first = vmRun(command, account, [fake.bin, '--verbose'], extra);
    const calls = fake.entries();
    assert.equal(calls.length, 1, label);
    const [call] = calls;
    assert.deepEqual(call.args, ['--verbose', ...RENEW_ARGS], label);
    assert.equal(call.stdin, RENEW_PROMPT, label);
    assert.equal(realDir(call.cwd), realDir(os.tmpdir()), label);
    assert.ok(launchInside(account.home, call.cwd) === false, `${label}: cwd outside the account folder`);
    assert.equal(call.configDir, account.configDir, label);
    assert.deepEqual(call.seen, [], `${label}: the run saw a seat or credential variable`);
    assert.equal(sha256(account.file), call.wrote, `${label}: the file is exactly claude's own write`);
    const renewedAt = JSON.parse(fs.readFileSync(account.file, 'utf8')).claudeAiOauth.expiresAt;
    const state = vmRun('vm-credential-state', account, [fake.bin], extra);
    const fetch = command === 'vm-credential' ? first : vmRun('vm-credential', account, [fake.bin], extra);
    if (command === 'vm-credential-state') assert.deepEqual(first, state, label);
    assert.deepEqual(fetch, { status: 0, stdout: RENEWED, stderr: '' }, label);
    assert.deepEqual(state, { status: 0, stdout: `signin\t${new Date(renewedAt).toISOString()}\n`, stderr: '' }, label);
    assert.equal(fake.entries().length, 1, `${label}: no second run once renewed`);
    assertNoCredential(label, fetch, state);
  }
});

test('vm-credential: every failure cause exits 3 with one coded line, and state prints it', (t) => {
  const missingClaude = path.join(tempDir(t), 'no-such-claude.mjs');
  const rows = [];
  const noFile = accountFolder(t, 'acct-1', null);
  rows.push(['no-signin-file', noFile, {}]);
  rows.push(['signed-out', accountFolder(t, 'acct-1', signInJson({ scopes: ['user:profile'] })), {}]);
  rows.push(['expired', accountFolder(t, 'acct-1', signInJson({ expiresAt: Date.now() + 60_000 })), { FAKE_EXIT: '1' }, 'claude fails, writes nothing']);
  rows.push(['expired', accountFolder(t, 'acct-1', signInJson({ expiresAt: Date.now() + 60_000 })),
    { FAKE_RENEW_TOKEN: RENEWED, FAKE_RENEW_REFRESH: RENEWED_REFRESH, FAKE_RENEW_LEFT_MS: '120000' }, 'claude writes 2 minutes']);
  rows.push(['no-claude', accountFolder(t, 'acct-1', signInJson({ expiresAt: Date.now() + 60_000 })), {}, 'a missing .js claude', missingClaude]);
  for (const [reason, account, extra, note = reason, bin] of rows) {
    const fake = fakeRenewClaude(t);
    const words = [bin ?? fake.bin];
    const env = { FAKE_RENEW_LOG: fake.log, ...extra };
    const before = extra.FAKE_RENEW_TOKEN ? null : fileState(account.file);
    const fetch = vmRun('vm-credential', account, words, env);
    const state = vmRun('vm-credential-state', account, words, env);
    assert.deepEqual(fetch, { status: 3, stdout: '', stderr: `MOE_VM_CREDENTIAL_UNAVAILABLE reason=${reason}\n` }, note);
    assert.deepEqual(state, { status: 0, stdout: `unavailable\t${reason}\n`, stderr: '' }, note);
    const renews = reason === 'expired' ? 2 : 0; // each command renews once, then reads once
    assert.equal(fake.entries().length, renews, note);
    if (before) assert.deepEqual(fileState(account.file), before, `${note}: file untouched`);
    assertNoCredential(note, fetch, state);
  }
});

test('resolveVmCredential renews at exactly 300000 ms left, never at 300001, and at most once', (t) => {
  const expiresAt = Date.now() + 2 * HOUR_MS;
  const account = accountFolder(t, 'acct-1', signInJson({ expiresAt }));
  const env = { MOE_ACCOUNTS_FILE: path.join(account.home, 'claude-accounts.json') };
  const resolve = (left, result = true) => {
    const calls = [];
    const renew = (...args) => {
      calls.push(args);
      return result;
    };
    const out = resolveVmCredential(env, 'acct-1', account.configDir, ['claude'], { now: () => expiresAt - left, renew });
    return { out, calls };
  };
  assert.deepEqual(resolve(300_001), { out: { source: 'signin', token: ACCESS, expiresAt }, calls: [] });
  const edge = resolve(300_000);
  assert.deepEqual(edge.out, { reason: 'expired' });
  assert.deepEqual(edge.calls, [[account.configDir, ['claude'], env]]);
  assert.deepEqual(resolve(300_000, false).out, { reason: 'no-claude' });
  assert.deepEqual(resolve(-1).calls.length, 1);
});

test('vm-credential and vm-credential-state refuse missing arguments with usage, exit 2', (t) => {
  const account = accountFolder(t);
  const env = cleanEnv({ MOE_ACCOUNTS_FILE: path.join(account.home, 'claude-accounts.json') });
  for (const args of [['vm-credential', 'acct-1', account.configDir], ['vm-credential-state'], ['vm-credential-state', 'acct-1'],
    ['vm-credential-state', 'acct-1', account.configDir], ['vm-credential', '', account.configDir, 'claude']]) {
    const out = helper(args, { env });
    assert.equal(out.status, 2, args.join(' '));
    assert.equal(out.stdout, '', args.join(' '));
    assert.match(out.stderr, /^usage: .*vm-credential-state <id> <configDir> <claude command\.\.\.>/, args.join(' '));
  }
});

test('vm-credential renews through an npm-style claude.cmd, keeping the empty --tools word', { skip: process.platform !== 'win32' && 'Windows only' }, (t) => {
  const fake = fakeRenewClaude(t);
  const bin = path.join(tempDir(t), 'npm global');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${fake.bin}" %*\r\n`);
  const account = accountFolder(t, 'acct-1', signInJson({ expiresAt: Date.now() + 60_000 }));
  const extra = { FAKE_RENEW_LOG: fake.log, FAKE_RENEW_TOKEN: RENEWED, FAKE_RENEW_REFRESH: RENEWED_REFRESH,
    PATH: `${bin};${process.env.SystemRoot}\\System32` };
  const fetch = vmRun('vm-credential', account, ['claude'], extra);
  assert.deepEqual(fetch, { status: 0, stdout: RENEWED, stderr: '' });
  const calls = fake.entries();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [...RENEW_ARGS]);
  assert.deepEqual(calls[0].args.slice(-2), ['--tools', '']);
  assert.equal(calls[0].stdin, RENEW_PROMPT);
  assert.deepEqual(calls[0].seen, []);
  assertNoCredential('claude.cmd', fetch, null);
});
