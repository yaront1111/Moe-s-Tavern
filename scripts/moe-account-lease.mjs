#!/usr/bin/env node
// Claude account rotation, wrapper side. moe-agent.{sh,ps1} lease an account
// from the daemon (moe.lease_account) before every claude launch; this helper
// turns the reply into one tab-separated line, checks an account's sign-in
// after a launch fails fast, pre-accepts an interactive seat's folder trust,
// and turns an interactive seat's statusline input into a usage sample.
// A Claude config directory is handed to claude as CLAUDE_CONFIG_DIR, and this
// helper opens exactly one file inside one: `trust` sets
// projects[<key>].hasTrustDialogAccepted in that account's .claude.json for an
// interactive seat, under claude's own lock (human sign-off 2026-10-26,
// task-7a0b1881). Nothing read from that file, no path from it and no env
// value is ever printed; .credentials.json and every other file in the folder
// are never opened. From `claude auth status --json` it reads the exit code
// and authMethod; nothing else in that output is printed, stored or sent.
//
//   gate                                         go | off | skip<TAB><note>
//   pick              (stdin: the lease reply)   leased<TAB><id><TAB><peak|?><TAB><configDir>
//                                                | wait<TAB><sec><TAB><retryAt> | off<TAB><note> | unavailable<TAB><why>
//   signin-state <configDir> <claude command...> subscription | signed_out | other | unknown
//   trust <configDir> <projectDir> [<launchDir>] trusted | granted | refused<TAB><sec><TAB><reason>
//   statusline        claude's statusLine command: prints a line, writes MOE_ACCOUNT_SAMPLE_FILE
//   statusline-settings <file>                   writes the --settings JSON that installs it
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Credentials that outrank a claude.ai login; never reach a leased claude. Same list as the daemon's accounts/registry.ts. */
export const TOKEN_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
/** Cloud-provider switches: with one set, claude ignores logins, so rotation stands down. Same list as registry.ts. */
export const PROVIDER_ENV = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

const SELF = fileURLToPath(import.meta.url);
const WINDOW_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_WINDOWS = 8;
const DEFAULT_RETRY_CAP_SEC = 300;
const PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const OFF_RE = /^(0|false|off|no)$/i;
const UNREADABLE = 'unavailable\tunreadable reply from the daemon';
const USAGE = 'usage: node moe-account-lease.mjs gate | pick | signin-state <configDir> <claude command...> '
  + '| trust <configDir> <projectDir> [<launchDir>] | statusline | statusline-settings <file>';
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const TRUST_LOCK_WAIT_MS = 2000;
const TRUST_POLL_MS = 50;
const GIT_TIMEOUT_MS = 10_000;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const TRUST_REASON = {
  missing: 'no .claude.json in the account folder',
  notFile: "the account's .claude.json is not a regular file",
  tooBig: "the account's .claude.json is over 16 MiB",
  notObject: "the account's .claude.json is not a JSON object",
  locked: "the account's .claude.json is locked by another claude",
  rewrite: "the account's .claude.json could not be rewritten",
  readBack: 'the trust entry did not read back',
  outside: 'the launch directory is outside the project',
};

const isOff = (value) => OFF_RE.test(String(value ?? '').trim());
const isSet = (value) => typeof value === 'string' && value.trim() !== '' && !isOff(value);
const oneLine = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** MOE_ACCOUNT_RETRY_SEC as a whole number of seconds >= 1, else 300. */
function retryCapSec(env) {
  const cap = Number.parseInt(env.MOE_ACCOUNT_RETRY_SEC ?? '', 10);
  return cap >= 1 ? cap : DEFAULT_RETRY_CAP_SEC;
}

/** `go`, `off` (MOE_ACCOUNT_ROTATION is 0/false/off/no), or `skip<TAB><note>` when a cloud provider is selected. */
export function gateLine(env = process.env) {
  if (isOff(env.MOE_ACCOUNT_ROTATION)) return 'off';
  const provider = PROVIDER_ENV.find((name) => isSet(env[name]));
  return provider
    ? `skip\tMOE_ACCOUNT_SKIPPED: ${provider} is set, so claude does not use claude.ai logins; launching without rotation.`
    : 'go';
}

/** A Windows daemon's drive path as a WSL wrapper sees it (/mnt/<drive>/...), the rule of TerminalAgentLauncher.toWslPath. */
export function localConfigDir(dir, platform = process.platform) {
  if (platform === 'win32') return dir;
  const match = /^([A-Za-z]):\/?(.*)$/.exec(dir.replace(/\\/g, '/'));
  if (!match) return dir;
  const drive = match[1].toLowerCase();
  return match[2] ? `/mnt/${drive}/${match[2]}` : `/mnt/${drive}`;
}

/** moe.lease_account's reply -> the one line the wrappers read (see the header). */
export function pickLine(text, env = process.env, platform = process.platform) {
  const raw = String(text ?? '').trim();
  if (!raw) return 'unavailable\tno reply from the daemon';
  let reply;
  try {
    reply = JSON.parse(raw);
  } catch {
    return UNREADABLE;
  }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return UNREADABLE;
  if (reply.rotation === false) {
    const reason = typeof reply.reason === 'string' ? oneLine(reply.reason) : '';
    return `off\t${reason ? `MOE_ACCOUNT_SKIPPED: ${reason}; launching without rotation.` : ''}`;
  }
  if (reply.rotation !== true) return UNREADABLE;
  if (reply.accountId === null) {
    if (typeof reply.retryInSec !== 'number' || !Number.isFinite(reply.retryInSec)) return UNREADABLE;
    const sec = Math.max(1, Math.min(Math.ceil(reply.retryInSec), retryCapSec(env)));
    return `wait\t${sec}\t${oneLine(reply.retryAt, 64) || '?'}`;
  }
  if (typeof reply.accountId !== 'string' || !ACCOUNT_ID_RE.test(reply.accountId)) return UNREADABLE;
  const dir = typeof reply.configDir === 'string' ? localConfigDir(reply.configDir, platform) : '';
  const absolute = platform === 'win32' ? path.win32.isAbsolute(dir) : path.posix.isAbsolute(dir);
  if (!dir || /[\t\r\n]/.test(dir) || !absolute) return `unavailable\tno usable config directory for ${reply.accountId}`;
  const peak = typeof reply.peakPercent === 'number' && Number.isFinite(reply.peakPercent)
    ? String(Math.round(reply.peakPercent * 10) / 10)
    : '?';
  return `leased\t${reply.accountId}\t${peak}\t${dir}`;
}

/** The env of a claude bound to one account: its config directory, and nothing that outranks or bypasses its login. */
export function accountEnv(env, dir, platform = process.platform) {
  const drop = new Set([...TOKEN_ENV, ...PROVIDER_ENV, 'CLAUDE_CONFIG_DIR']);
  const next = {};
  for (const [name, value] of Object.entries(env)) {
    // Windows env names are case-insensitive: drop every spelling.
    if (!drop.has(platform === 'win32' ? name.toUpperCase() : name)) next[name] = value;
  }
  next.CLAUDE_CONFIG_DIR = dir;
  return next;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Windows env names are case-insensitive, but a copied env is a plain object ("Path", not "PATH"). */
function envValue(env, name) {
  return Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
}

/**
 * Where cmd.exe would find `bin`: PATH x PATHEXT, or the path itself when it
 * names a folder; the current directory is skipped. The daemon CLI's
 * findWindowsCommand (accounts/claudeAuth.ts), kept identical. Resolving first
 * is how a missing claude is told apart from a signed-out one: `cmd /c
 * <missing>` exits 1, the same code a signed-out `claude auth status` returns.
 */
export function findWindowsCommand(bin, env = process.env, exists = isFile) {
  const exts = (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').filter(Boolean);
  const names = path.win32.extname(bin) ? [bin, ...exts.map((ext) => bin + ext)] : exts.map((ext) => bin + ext);
  const dirs = /[\\/]/.test(bin)
    ? ['']
    : (envValue(env, 'PATH') ?? '').split(';').map((dir) => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? path.win32.join(dir, name) : name;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function quoteForCmd(word) {
  return word === '' || /[\s&()^|<>,;=]/.test(word) ? `"${word}"` : word;
}

/**
 * How to run `<command words> auth status --json`: { file, args, shell }, or
 * null when it cannot be run safely (the probe is then `unknown`). A .js/.mjs/
 * .cjs claude runs under this node. On Windows the command is resolved first
 * (findWindowsCommand); an .exe/.com runs directly and anything else (npm's
 * claude.cmd shim) through cmd.exe, which expands %VAR% even inside quotes and
 * has no escape for '"', so a word carrying either is not run at all.
 */
export function probeCommand(words, env = process.env, platform = process.platform, exists = isFile) {
  const [bin, ...rest] = words;
  if (!bin) return null;
  const args = [...rest, 'auth', 'status', '--json'];
  if (/\.[cm]?js$/i.test(bin)) return exists(bin) ? { file: process.execPath, args: [bin, ...args], shell: false } : null;
  if (platform !== 'win32') return { file: bin, args, shell: false };
  const found = findWindowsCommand(bin, env, exists);
  if (found === null) return null;
  if (/\.(exe|com)$/i.test(found)) return { file: found, args, shell: false };
  const line = [found, ...args];
  if (line.some((word) => /["%!\r\n]/.test(word))) return null;
  return { file: line.map(quoteForCmd).join(' '), args: [], shell: true };
}

/**
 * Exit code and authMethod only. `claude auth status --json` prints its JSON
 * and exits 1 when signed out, so a non-zero exit is `signed_out` only when
 * claude printed a JSON object; any other failure (a flag the operator's
 * command breaks on, a crash) is `unknown`. Stricter than the daemon CLI's
 * check on purpose: this probe runs the operator's command words, and one
 * broken command must not sign every account out in turn.
 */
export function signInStateOf(result) {
  if (!result || result.notFound || typeof result.status !== 'number') return 'unknown';
  let parsed = null;
  try {
    parsed = JSON.parse(String(result.stdout ?? ''));
  } catch {
    return 'unknown';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
  if (result.status !== 0) return 'signed_out';
  return parsed.authMethod === 'claude.ai' ? 'subscription' : 'other';
}

/** Runs `<command words> auth status --json` under the account's directory; stderr is discarded, stdout never echoed. */
export function probeSignIn(configDir, words, env = process.env, platform = process.platform) {
  const plan = probeCommand(words, env, platform);
  if (!plan) return 'unknown';
  const options = {
    env: accountEnv(env, configDir, platform),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: PROBE_TIMEOUT_MS,
  };
  const result = plan.shell ? spawnSync(plan.file, { ...options, shell: true }) : spawnSync(plan.file, plan.args, options);
  return signInStateOf({
    status: result.error ? null : result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    notFound: result.error?.code === 'ENOENT',
  });
}

/** statusLine stdin `rate_limits.<window>.{used_percentage, resets_at}` -> report windows (percent 0-100, resetsAt epoch s). */
export function statuslineSample(input) {
  const windows = {};
  const limits = input?.rate_limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return windows;
  for (const [name, value] of Object.entries(limits)) {
    if (Object.keys(windows).length >= MAX_WINDOWS) break;
    if (!WINDOW_RE.test(name) || !value || typeof value !== 'object') continue;
    if (typeof value.used_percentage !== 'number' || !Number.isFinite(value.used_percentage)) continue;
    windows[name] = {
      percent: value.used_percentage,
      ...(typeof value.resets_at === 'number' && Number.isFinite(value.resets_at) && { resetsAt: value.resets_at }),
    };
  }
  return windows;
}

/** The status line itself: model | account | 5h 42% | 7d 63%. ASCII only, so any console shows it. */
export function formatStatus(input, accountId, windows) {
  const short = { five_hour: '5h', seven_day: '7d' };
  const model = oneLine(input?.model?.display_name || input?.model?.id, 40) || 'claude';
  const usage = Object.entries(windows).map(([name, window]) => `${short[name] ?? name} ${Math.floor(window.percent)}%`);
  return [model, accountId || 'no account', ...usage].join(' | ');
}

/**
 * The --settings JSON an interactive leased seat gets, so its statusline feeds
 * the usage sample. On Windows claude runs the command through Git Bash, or
 * PowerShell without it: a bare `node` and a single-quoted forward-slash path
 * read the same in both (null when the path holds a quote).
 */
export function statuslineSettingsJson(nodePath, scriptPath, platform = process.platform) {
  let command;
  if (platform === 'win32') {
    const script = scriptPath.replace(/\\/g, '/');
    if (script.includes("'")) return null;
    command = `node '${script}' statusline`;
  } else {
    const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
    command = `${quote(nodePath)} ${quote(scriptPath)} statusline`;
  }
  return JSON.stringify({ statusLine: { type: 'command', command } });
}

/** Atomic, so the wrapper never reads half a sample. */
export function writeSample(file, sample) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sample), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// --- trust: claude stops an interactive launch at "Do you trust the files in
// this folder?" unless projects[<git top-level of the cwd, else the cwd>] (or
// a projects[dir] on the walk from the cwd up to it) in $CLAUDE_CONFIG_DIR/
// .claude.json has hasTrustDialogAccepted: true; -p never asks. Accepting the
// dialog writes that key, '/'-separated on Windows. claude saves the file under
// a mkdir lock at `<file>.lock` (proper-lockfile), re-reading under it, as
// JSON.stringify(config, null, 2) without a trailing newline: so does this.

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function attempt(fn, dir) {
  try {
    return fn(dir);
  } catch {
    return null;
  }
}

// cwd: Windows looks a bare command up in the current directory first, and that
// is the project being trusted; node's own folder is not.
function gitTopLevel(dir) {
  const result = spawnSync('git', ['-C', path.resolve(dir), 'rev-parse', '--show-toplevel'], {
    cwd: path.dirname(process.execPath), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS, windowsHide: true,
  });
  return result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() || null : null;
}

/** The key forms claude may look a directory up under: Windows gets '/' separators and an uppercase drive too. */
function keyForms(dir, platform) {
  if (platform !== 'win32') return [path.posix.resolve(dir)];
  const key = path.win32.resolve(dir).replace(/\\/g, '/');
  const trimmed = /^[A-Za-z]:\/$/.test(key) ? key : key.replace(/\/+$/, '');
  return [trimmed, trimmed.replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase())];
}

/** Every key to trust for a launch directory: the directory, its real path and its git top-level, deduped. */
export function trustKeys(dir, { platform = process.platform, realpath = fs.realpathSync, gitTop = gitTopLevel } = {}) {
  const keys = new Set();
  for (const candidate of [dir, attempt(realpath, dir), attempt(gitTop, dir)]) {
    if (typeof candidate === 'string' && candidate) keyForms(candidate, platform).forEach((key) => keys.add(key));
  }
  return [...keys];
}

/** True when `launchDir` is `projectDir` or below it (Windows compares case-insensitively). */
export function launchInside(projectDir, launchDir, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const rel = paths.relative(paths.resolve(projectDir), paths.resolve(launchDir));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel));
}

/** { config, mode } or { reason }: a regular file of at most 16 MiB holding a JSON object whose projects is an object if set. */
function readConfig(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return { reason: TRUST_REASON.missing };
  }
  if (!stat.isFile()) return { reason: TRUST_REASON.notFile };
  if (stat.size > MAX_CONFIG_BYTES) return { reason: TRUST_REASON.tooBig };
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { reason: TRUST_REASON.notObject };
  }
  if (!isPlainObject(config) || (config.projects !== undefined && !isPlainObject(config.projects))) return { reason: TRUST_REASON.notObject };
  return { config, mode: stat.mode & 0o777 };
}

function isTrusted(config, keys) {
  const projects = config.projects ?? {};
  return keys.every((key) => Object.hasOwn(projects, key) && isPlainObject(projects[key]) && projects[key].hasTrustDialogAccepted === true);
}

/** 'held' (this call created the lock), 'busy' (another holder for the whole wait) or 'error'. */
function takeLock(lockDir, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return 'held';
    } catch (error) {
      if (error?.code !== 'EEXIST') return 'error';
      const left = deadline - Date.now();
      if (left <= 0) return 'busy';
      sleepMs(Math.min(TRUST_POLL_MS, left));
    }
  }
}

/** Temp file + rename in the same folder, with the original mode; Windows may refuse a rename for a moment. */
function replaceFile(file, text, mode) {
  const tmp = `${file}.moe-${process.pid}.tmp`;
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, text, { flag: 'wx', mode });
    fs.chmodSync(tmp, mode);
    for (let tries = 1; ; tries += 1) {
      try {
        fs.renameSync(tmp, file);
        return true;
      } catch (error) {
        if (tries >= 5 || !RENAME_RETRY_CODES.has(error?.code)) throw error;
        sleepMs(TRUST_POLL_MS);
      }
    }
  } catch {
    attempt((name) => fs.rmSync(name, { force: true }), tmp);
    return false;
  }
}

/** Under claude's lock: re-read, set the missing keys, rewrite, read back. 'trusted', 'granted' or a refusal reason. */
function grantLocked(file, keys, waitMs) {
  const lockDir = `${file}.lock`;
  const lock = takeLock(lockDir, waitMs);
  if (lock !== 'held') return lock === 'busy' ? TRUST_REASON.locked : TRUST_REASON.rewrite;
  try {
    const current = readConfig(file);
    if (current.reason) return current.reason;
    const { config } = current;
    if (isTrusted(config, keys)) return 'trusted';
    config.projects ??= {};
    for (const key of keys) {
      const entry = Object.hasOwn(config.projects, key) && isPlainObject(config.projects[key]) ? config.projects[key] : {};
      if (entry.hasTrustDialogAccepted !== true) config.projects[key] = { ...entry, hasTrustDialogAccepted: true };
    }
    if (!replaceFile(file, JSON.stringify(config, null, 2), current.mode)) return TRUST_REASON.rewrite;
    const after = readConfig(file);
    return !after.reason && isTrusted(after.config, keys) ? 'granted' : TRUST_REASON.readBack;
  } finally {
    // Only ever this call's own lock; a lock left by a killed holder goes stale for claude after 10 s.
    attempt((dir) => fs.rmdirSync(dir), lockDir);
  }
}

/**
 * `trusted`, `granted`, or `refused<TAB><sec><TAB><reason>` (one fixed reason;
 * sec = MOE_ACCOUNT_RETRY_SEC, else 300). A launch directory outside the
 * project is never granted. Options: env, platform, realpath, gitTop, lockWaitMs.
 */
export function trustLine(configDir, projectDir, launchDir = projectDir, options = {}) {
  const { env = process.env, lockWaitMs = TRUST_LOCK_WAIT_MS, ...keyOptions } = options;
  const refused = (reason) => `refused\t${retryCapSec(env)}\t${reason}`;
  try {
    const keys = trustKeys(launchDir, keyOptions);
    const file = path.join(configDir, '.claude.json');
    const first = readConfig(file);
    const trusted = !first.reason && isTrusted(first.config, keys);
    if (!launchInside(projectDir, launchDir, keyOptions.platform)) return trusted ? 'trusted' : refused(TRUST_REASON.outside);
    // A file that does not parse may be one claude is writing: grantLocked reads it again under the lock.
    if (first.reason && first.reason !== TRUST_REASON.notObject) return refused(first.reason);
    if (trusted) return 'trusted';
    const result = grantLocked(file, keys, lockWaitMs);
    return result === 'trusted' || result === 'granted' ? result : refused(result);
  } catch {
    return refused(TRUST_REASON.rewrite);
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function statusline(env) {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    /* the fallback line */
  }
  const windows = statuslineSample(input);
  const accountId = ACCOUNT_ID_RE.test(env.MOE_ACCOUNT_ID ?? '') ? env.MOE_ACCOUNT_ID : '';
  if (accountId && env.MOE_ACCOUNT_SAMPLE_FILE && Object.keys(windows).length) {
    try {
      writeSample(env.MOE_ACCOUNT_SAMPLE_FILE, { accountId, windows, refused: false });
    } catch {
      /* best effort: a sample never breaks the status line */
    }
  }
  console.log(formatStatus(input, accountId, windows));
}

export function main(argv, env = process.env) {
  const [command, ...args] = argv;
  switch (command) {
    case 'gate':
      console.log(gateLine(env));
      return 0;
    case 'pick':
      console.log(pickLine(readStdin(), env));
      return 0;
    case 'signin-state': {
      const [configDir, ...words] = args;
      if (!configDir || !words[0]) {
        console.log('unknown');
        return 2;
      }
      console.log(probeSignIn(configDir, words, env));
      return 0;
    }
    case 'trust': {
      const [configDir, projectDir, launchDir] = args;
      if (!configDir || !projectDir) {
        console.error(USAGE);
        return 2;
      }
      console.log(trustLine(configDir, projectDir, launchDir || projectDir, { env }));
      return 0;
    }
    case 'statusline':
      // claude runs this after every message: one line and exit 0, whatever happens.
      try {
        statusline(env);
      } catch {
        console.log('claude');
      }
      return 0;
    case 'statusline-settings': {
      const json = args[0] ? statuslineSettingsJson(process.execPath, SELF) : null;
      if (json === null) {
        console.error(USAGE);
        return 2;
      }
      fs.writeFileSync(args[0], json, { mode: 0o600 });
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const [a, b] = [fs.realpathSync(process.argv[1]), fs.realpathSync(SELF)];
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`moe-account-lease: ${error.message}`);
    process.exitCode = 1;
  }
}
