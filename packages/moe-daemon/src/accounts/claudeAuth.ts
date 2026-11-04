// =============================================================================
// Running claude for one account: sign in, sign out, and the sign-in check
// =============================================================================
//
// Used only by the `accounts` CLI (accounts/cli.ts), which runs in a terminal
// the person can see; the daemon process never runs claude. Every claude
// process here gets CLAUDE_CONFIG_DIR=<the account's directory> and loses the
// variables that would outrank that directory's login (TOKEN_ENV) or skip
// logins altogether (PROVIDER_ENV). From `claude auth status --json` Moe takes
// the exit code and the authMethod field, nothing else: the rest of the
// output is never printed, stored or sent.
//
// Under the protected profile (the CLI's --protected-project, task-55710898)
// protectedClaudeCommand takes claude only from an absolute PATH entry (or
// MOE_CLAUDE_BIN) outside the project, and runClaude starts it with PATH = the
// kept entries and cwd = the home folder, so neither claude, nor the node an npm
// shim starts, nor the project's .claude settings is reached through the project.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PROVIDER_ENV, TOKEN_ENV, type SignInState } from './registry.js';

const PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export interface ClaudeCommand {
  file: string;
  prefix: string[];
  /** Windows needs the shell for an npm .cmd shim. */
  shell: boolean;
  /** Windows: nothing on PATH matched, so claude is not run at all (see findWindowsCommand). */
  missing: boolean;
  /** Protected profile only: the claude child's PATH, its cwd and, for a Windows .cmd or .bat claude, the absolute cmd.exe. */
  pinned?: { path: string; cwd: string; cmd?: string };
}

/** The protected lookup refused; the message starts with MOE_PROTECTED_CLAUDE_REFUSED or MOE_PROTECTED_CLAUDE_NOT_FOUND. */
export class ProtectedClaudeRefused extends Error {}

export interface ClaudeRun {
  /** null when claude did not finish (could not start, or timed out). */
  status: number | null;
  stdout: string;
  notFound: boolean;
}

/** Windows env names are case-insensitive, but a copied env is a plain object ("Path", not "PATH"). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
}

/** The names cmd.exe tries for `bin`: bin + each PATHEXT entry, after bin itself when it has an extension. */
function pathextNames(bin: string, env: NodeJS.ProcessEnv): string[] {
  const exts = (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').filter(Boolean);
  return path.win32.extname(bin) ? [bin, ...exts.map((ext) => bin + ext)] : exts.map((ext) => bin + ext);
}

/**
 * Where cmd.exe would find `bin`: PATH x PATHEXT, or the path itself when it
 * names a folder. The current directory itself is skipped, but a '.' or
 * relative PATH entry still resolves against it (the protected lookup,
 * protectedClaudeCommand, task-55710898, drops those). Resolving first is how a
 * missing claude is told apart from a signed-out one: `cmd /c <missing>` exits
 * 1, the same code as `claude auth status` for a signed-out account.
 */
export function findWindowsCommand(bin: string, env: NodeJS.ProcessEnv): string | null {
  const names = pathextNames(bin, env);
  const dirs = /[\\/]/.test(bin) ? [''] : (envValue(env, 'PATH') ?? '').split(';').map((dir) => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? path.win32.join(dir, name) : name;
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** MOE_CLAUDE_BIN, else `claude` on PATH. A .js/.mjs/.cjs file runs under this node (the tests' fake claude). */
export function claudeCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ClaudeCommand {
  const bin = env.MOE_CLAUDE_BIN?.trim() || 'claude';
  if (/\.[cm]?js$/i.test(bin)) return { file: process.execPath, prefix: [bin], shell: false, missing: false };
  if (platform !== 'win32') return { file: bin, prefix: [], shell: false, missing: false };
  const found = findWindowsCommand(bin, env);
  if (found === null) return { file: bin, prefix: [], shell: false, missing: true };
  // An npm install puts a claude.cmd shim on PATH, which only cmd.exe can run.
  return { file: found, prefix: [], shell: !/\.(exe|com)$/i.test(found), missing: false };
}

/**
 * The real path and stat of a local path, or null. Local: drive-qualified on Windows
 * (never UNC, device, rooted or drive-relative), absolute elsewhere. A Windows real
 * path must stay drive-qualified, because a mapped drive resolves to UNC.
 */
function localEntry(p: string): { real: string; st: fs.BigIntStats } | null {
  const local = (q: string) => (process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(q) : path.isAbsolute(q));
  try {
    const real = local(p) ? fs.realpathSync.native(p) : '';
    return local(real) ? { real, st: fs.statSync(real, { bigint: true }) } : null;
  } catch {
    return null;
  }
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const foldCase = (p: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);

/**
 * True when `real` or an ancestor of it is the project: the same real path, or the
 * same bigint stat identity (drvfs keeps case-variant spellings), as the -ef walk of
 * protected_trusted_dir in scripts/moe-agent.sh. A failed stat counts as inside.
 */
function inProject(real: string, project: { key: string; st: fs.BigIntStats }): boolean {
  try {
    for (let up = real; ; up = path.dirname(up)) {
      const st = fs.statSync(up, { bigint: true });
      if (foldCase(up) === project.key || (project.st.ino !== 0n && st.dev === project.st.dev && st.ino === project.st.ino)) return true;
      if (path.dirname(up) === up) return false;
    }
  } catch {
    return true;
  }
}

/**
 * The protected profile's claude (task-55710898): only from a kept PATH entry (an
 * absolute folder outside the project, as its real path) or an absolute
 * MOE_CLAUDE_BIN outside the project, pinned to run with PATH = the kept entries
 * and cwd = the home folder. Throws ProtectedClaudeRefused before anything runs.
 */
export function protectedClaudeCommand(env: NodeJS.ProcessEnv, project: string): ClaudeCommand {
  const win = process.platform === 'win32';
  const refuse = (reason: string): never => {
    throw new ProtectedClaudeRefused(`MOE_PROTECTED_CLAUDE_REFUSED: ${reason}; nothing was run.`);
  };
  const own = localEntry(project);
  if (!own?.st.isDirectory()) return refuse(`the project ${project} is not a local folder`);
  const id = { key: foldCase(own.real), st: own.st };
  /** The real path of a local folder (or file) outside the project, else null. */
  const outside = (p: string, folder: boolean): string | null => {
    const entry = localEntry(p);
    return entry && (folder ? entry.st.isDirectory() : entry.st.isFile()) && !inProject(entry.real, id) ? entry.real : null;
  };
  const kept: string[] = [];
  for (const entry of ((win ? envValue(env, 'PATH') : env.PATH) ?? '').split(path.delimiter)) {
    const real = outside(win ? entry.trim().replace(/^"(.*)"$/, '$1') : entry, true);
    if (real !== null && !kept.includes(real)) kept.push(real);
  }
  if (kept.length === 0) refuse(`no absolute PATH entry is outside the project ${project}`);
  const home = (win ? envValue(env, 'USERPROFILE') : env.HOME) || os.homedir();
  const cwd = outside(home, true) ?? refuse(`the home folder ${home} is not a local folder outside the project ${project}`);
  const bin = env.MOE_CLAUDE_BIN?.trim() || 'claude';
  const names = win ? pathextNames(bin, env) : [bin];
  const file = (win ? /[\\/]/.test(bin) : bin.includes('/'))
    ? outside(bin, false) ?? refuse(`MOE_CLAUDE_BIN ${bin} is not an absolute file outside the project ${project}`)
    : kept.flatMap((dir) => names.map((name) => outside(path.join(dir, name), false))).find((real) => real !== null && (win || executable(real)));
  if (!file) {
    throw new ProtectedClaudeRefused(`MOE_PROTECTED_CLAUDE_NOT_FOUND: "${bin}" was not found on an absolute PATH entry outside the project ${project}; nothing was run. Install Claude Code outside the project and put its folder on PATH, then try again.`);
  }
  const pinned = { path: kept.join(path.delimiter), cwd };
  if (/\.[cm]?js$/i.test(file)) return { file: process.execPath, prefix: [file], shell: false, missing: false, pinned };
  if (!win || /\.(exe|com)$/i.test(file)) return { file, prefix: [], shell: false, missing: false, pinned };
  const root = envValue(env, 'SYSTEMROOT');
  const cmd = (root && outside(path.win32.join(root, 'System32', 'cmd.exe'), false)) || refuse(`cmd.exe under SystemRoot ${root || '(unset)'} is not a local file outside the project ${project}`);
  return { file, prefix: [], shell: true, missing: false, pinned: { ...pinned, cmd } };
}

/** A pinned claude's env: PATH replaced (every spelling on Windows, where cmd.exe also stops searching its cwd first). */
function pinnedEnv(env: NodeJS.ProcessEnv, pathValue: string): NodeJS.ProcessEnv {
  const win = process.platform === 'win32';
  const replaced = win ? ['PATH', 'NODEFAULTCURRENTDIRECTORYINEXEPATH'] : ['PATH'];
  const copy = Object.fromEntries(Object.entries(env).filter(([name]) => !replaced.includes(win ? name.toUpperCase() : name)));
  return win ? { ...copy, PATH: pathValue, NoDefaultCurrentDirectoryInExePath: '1' } : { ...copy, PATH: pathValue };
}

/** The env for a claude process bound to one account directory. */
export function accountEnv(base: NodeJS.ProcessEnv, configDir: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const drop = new Set<string>([...TOKEN_ENV, ...PROVIDER_ENV, 'CLAUDE_CONFIG_DIR']);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    // Windows env names are case-insensitive: drop every spelling.
    if (!drop.has(platform === 'win32' ? name.toUpperCase() : name)) env[name] = value;
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

function quoteForCmd(file: string): string {
  return /[\s&()^|<>]/.test(file) ? `"${file}"` : file;
}

/**
 * Run claude with fixed arguments. `interactive` hands it the terminal (sign-in
 * prompts, the browser link); otherwise stdout is captured for the caller and
 * stderr is discarded.
 */
export function runClaude(command: ClaudeCommand, args: string[], env: NodeJS.ProcessEnv, interactive: boolean): ClaudeRun {
  if (command.missing) return { status: null, stdout: '', notFound: true };
  const pinned = command.pinned;
  const options = {
    env: pinned ? pinnedEnv(env, pinned.path) : env,
    ...(pinned ? { cwd: pinned.cwd } : {}),
    encoding: 'utf8' as const,
    windowsHide: !interactive,
    stdio: interactive ? ('inherit' as const) : (['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore']),
    ...(interactive ? {} : { timeout: PROBE_TIMEOUT_MS }),
  };
  // The arguments are fixed words, so joining them for the shell is safe. A pinned
  // cmd.exe path still gets cmd's /d /s /c from node, because it ends in cmd.exe.
  const result = command.shell
    ? spawnSync([quoteForCmd(command.file), ...command.prefix, ...args].join(' '), { ...options, shell: pinned?.cmd ?? true })
    : spawnSync(command.file, [...command.prefix, ...args], options);
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: result.error ? null : result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    // POSIX execvp keeps searching past an unsearchable PATH directory (or a claude without the execute bit),
    // then fails EACCES, not ENOENT. For a PATH lookup that still means no runnable claude; an explicit path stays 'unknown'.
    notFound: errorCode === 'ENOENT' || (errorCode === 'EACCES' && path.basename(command.file) === command.file),
  };
}

/** Exit code and authMethod only: 0 + "claude.ai" is a subscription, 0 + anything else is "other", non-zero is signed out. */
export function signInStateOf(run: ClaudeRun): SignInState | 'unknown' {
  if (run.notFound || run.status === null) return 'unknown';
  if (run.status !== 0) return 'signed_out';
  try {
    const parsed = JSON.parse(run.stdout) as { authMethod?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return 'unknown';
    return parsed.authMethod === 'claude.ai' ? 'subscription' : 'other';
  } catch {
    return 'unknown';
  }
}

export function probeSignIn(command: ClaudeCommand, env: NodeJS.ProcessEnv): { state: SignInState | 'unknown'; notFound: boolean } {
  const run = runClaude(command, ['auth', 'status', '--json'], env, false);
  return { state: signInStateOf(run), notFound: run.notFound };
}
