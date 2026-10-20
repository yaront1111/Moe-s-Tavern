// scripts/moe-account-lease.mjs: the wrapper side of Claude account rotation.
// Every case uses temp directories and a fake claude written here. Nothing in
// this file runs the real claude or opens a real Claude config directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PROVIDER_ENV,
  TOKEN_ENV,
  accountEnv,
  findWindowsCommand,
  formatStatus,
  gateLine,
  localConfigDir,
  pickLine,
  probeCommand,
  signInStateOf,
  statuslineSample,
  statuslineSettingsJson,
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
