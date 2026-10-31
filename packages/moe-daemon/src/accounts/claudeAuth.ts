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

import { spawnSync } from 'child_process';
import fs from 'fs';
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
}

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

/**
 * Where cmd.exe would find `bin`: PATH x PATHEXT, or the path itself when it
 * names a folder. The current directory is skipped, so a claude.cmd inside a
 * project never runs. Resolving first is how a missing claude is told apart
 * from a signed-out one: `cmd /c <missing>` exits 1, the same code as
 * `claude auth status` for a signed-out account.
 */
export function findWindowsCommand(bin: string, env: NodeJS.ProcessEnv): string | null {
  const exts = (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').filter(Boolean);
  const names = path.win32.extname(bin) ? [bin, ...exts.map((ext) => bin + ext)] : exts.map((ext) => bin + ext);
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
  const options = {
    env,
    encoding: 'utf8' as const,
    windowsHide: !interactive,
    stdio: interactive ? ('inherit' as const) : (['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore']),
    ...(interactive ? {} : { timeout: PROBE_TIMEOUT_MS }),
  };
  // The arguments are fixed words, so joining them for the shell is safe.
  const result = command.shell
    ? spawnSync([quoteForCmd(command.file), ...command.prefix, ...args].join(' '), { ...options, shell: true })
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
