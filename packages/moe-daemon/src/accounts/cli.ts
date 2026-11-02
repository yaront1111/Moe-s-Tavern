// =============================================================================
// `accounts` CLI: manage this machine's Claude subscription accounts
// =============================================================================
//
//   node <daemon>/dist/accounts/cli.js <command>
//   node <daemon>/dist/index.js accounts <command>
//
//   list                      one line per account: id, label, sign-in state, config directory
//   add [--label <text>]      register a new, signed-out account and print its id
//   login <id>                Claude's own subscription sign-in for that account
//   logout <id>               sign that account out
//   check [<id>]              re-check sign-ins; exit 0 only when every checked account is on a subscription
//   remove <id> [--sign-out]  unregister (signing out first with --sign-out); the directory stays
//   vm-token <id> [--remove]  mint (or delete) the account's long-lived token for Moe VM jobs
//
// --accounts-file <path> picks the registry (else MOE_ACCOUNTS_FILE, else
// ~/.moe/claude-accounts.json). MOE_CLAUDE_BIN picks the claude binary.
//
// The JetBrains Accounts tab runs these commands in an IDE terminal, so the
// person sees and answers Claude's own sign-in prompts. This file imports only
// node built-ins and this folder, so any node can run it, including WSL's node
// over a /mnt path.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  RegistryError,
  accountConfigDir,
  addAccount,
  findAccount,
  readRegistry,
  recordSignIn,
  registryFilePath,
  removeAccount,
  type RegistryAccount,
  type SignInState,
} from './registry.js';
import { accountEnv, claudeCommand, probeSignIn, runClaude } from './claudeAuth.js';
import { VM_TOKEN_RE, readHiddenLine, removeVmToken, writeVmToken } from './vmTokens.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  env: NodeJS.ProcessEnv;
  /** One line typed with echo off (tests inject it); default readHiddenLine. */
  readSecret?(prompt: string): string | null;
}

const defaultIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
};

const USAGE = [
  'Usage: accounts <command> [--accounts-file <path>]',
  '  list                      list the Claude accounts',
  '  add [--label <text>]      add an account (signed out until you sign it in)',
  '  login <id>                sign the account in with your Claude subscription',
  '  logout <id>               sign the account out',
  '  check [<id>]              check which accounts are signed in',
  '  remove <id> [--sign-out]  remove the account (sign it out first with --sign-out)',
  "  vm-token <id> [--remove]  mint (or delete) the account's long-lived token for Moe VM jobs",
];

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  label?: string;
  accountsFile?: string;
  signOut: boolean;
  remove: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: undefined, positional: [], signOut: false, remove: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = (): string => {
      const next = inline ?? argv[++i];
      if (next === undefined) throw new UsageError(`${flag} needs a value`);
      return next;
    };
    if (flag === '--accounts-file') parsed.accountsFile = value();
    else if (flag === '--label') parsed.label = value();
    else if (flag === '--sign-out') parsed.signOut = true;
    else if (flag === '--remove') parsed.remove = true;
    else if (flag.startsWith('-')) throw new UsageError(`unknown option ${flag}`);
    else if (parsed.command === undefined) parsed.command = arg;
    else parsed.positional.push(arg);
  }
  return parsed;
}

function describe(account: RegistryAccount): string {
  return account.label === account.id ? account.id : `${account.label} (${account.id})`;
}

/** Look the account up, or fail with MOE_ACCOUNT_UNKNOWN. */
function accountFor(file: string, id: string | undefined): RegistryAccount {
  if (!id) throw new UsageError('give the account id, for example acct-1');
  const registry = readRegistry(file);
  if (!registry) throw new RegistryError('MOE_ACCOUNT_UNKNOWN', `no Claude account "${id}" is registered (${file} does not exist yet)`);
  return findAccount(registry, id);
}

function notFoundMessage(io: CliIo): string {
  const bin = io.env.MOE_CLAUDE_BIN?.trim() || 'claude';
  return `MOE_CLAUDE_NOT_FOUND: could not run "${bin}". Install Claude Code where this terminal runs (and put it on PATH), then try again.`;
}

/** Ask claude whether the account is signed in, and record the answer. */
function check(io: CliIo, file: string, account: RegistryAccount): SignInState | 'unknown' | 'not-found' {
  const { state, notFound } = probeSignIn(claudeCommand(io.env), accountEnv(io.env, accountConfigDir(file, account.id)));
  if (notFound) return 'not-found';
  if (state !== 'unknown') recordSignIn(file, account.id, state);
  return state;
}

function signOut(io: CliIo, file: string, account: RegistryAccount): number {
  const run = runClaude(claudeCommand(io.env), ['auth', 'logout'], accountEnv(io.env, accountConfigDir(file, account.id)), true);
  if (run.notFound) {
    io.err(notFoundMessage(io));
    return 1;
  }
  const state = check(io, file, account);
  if (state !== 'signed_out') {
    io.err(`MOE_ACCOUNT_LOGOUT_FAILED: ${describe(account)} is still signed in (sign-in check: ${state}).`);
    return 1;
  }
  io.out(`Signed out: ${describe(account)}.`);
  return 0;
}

function login(io: CliIo, file: string, account: RegistryAccount): number {
  const dir = accountConfigDir(file, account.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  io.err(`Signing in ${describe(account)} with your Claude subscription.`);
  io.err('Claude opens a sign-in page in your browser (or prints a link). Sign in with the Claude account you want in this slot, then come back here.');
  const run = runClaude(claudeCommand(io.env), ['auth', 'login', '--claudeai'], accountEnv(io.env, dir), true);
  if (run.notFound) {
    io.err(notFoundMessage(io));
    return 1;
  }
  const state = check(io, file, account);
  if (state === 'not-found') {
    io.err(notFoundMessage(io));
    return 1;
  }
  if (state === 'subscription') {
    io.out(`Signed in: ${describe(account)} uses a Claude subscription. Moe can use it now.`);
    return 0;
  }
  if (state === 'other') {
    io.err(`MOE_ACCOUNT_NOT_SUBSCRIPTION: ${describe(account)} is signed in, but not with a Claude subscription (claude.ai). Moe only rotates subscription accounts. Run the sign-in again and choose your Claude subscription.`);
    return 1;
  }
  io.err(`MOE_ACCOUNT_LOGIN_FAILED: ${describe(account)} is not signed in (claude auth login exited with ${run.status ?? 'no exit code'}; sign-in check: ${state}). Try again.`);
  return 1;
}

/**
 * Claude's own `claude setup-token`, run interactively in the account folder,
 * then the token pasted at a hidden prompt: capturing the TUI's output is
 * unreliable. No message ever includes the token.
 */
function vmToken(io: CliIo, file: string, account: RegistryAccount): number {
  const dir = accountConfigDir(file, account.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  io.err(`Minting a long-lived token for ${describe(account)} for Moe VM jobs. Claude opens its sign-in page (or prints a link). Sign in with the SAME Claude account as this slot: Moe cannot check which account a token belongs to.`);
  io.err('When claude prints the token, copy it; you paste it here next (input hidden).');
  const run = runClaude(claudeCommand(io.env), ['setup-token'], accountEnv(io.env, dir), true);
  if (run.notFound) {
    io.err(notFoundMessage(io));
    return 1;
  }
  if (run.status !== 0) {
    io.err(`MOE_VM_TOKEN_MINT_FAILED: claude setup-token exited with ${run.status ?? 'no exit code'}; nothing was stored.`);
    return 1;
  }
  const prompt = 'Paste the token (input hidden): ';
  const token = (io.readSecret ? io.readSecret(prompt) : readHiddenLine(prompt))?.trim();
  if (!token) {
    io.err('MOE_VM_TOKEN_NOT_STORED: no token was entered; nothing was stored.');
    return 1;
  }
  if (!VM_TOKEN_RE.test(token)) {
    io.err('MOE_VM_TOKEN_INVALID: that is not a Claude long-lived token (sk-ant-oat…); nothing was stored.');
    return 1;
  }
  accountFor(file, account.id); // removed while the prompt waited: MOE_ACCOUNT_UNKNOWN, nothing stored
  try {
    writeVmToken(file, account.id, token);
  } catch (error) {
    io.err(`MOE_VM_TOKEN_NOT_STORED: the token store could not be written (${(error as NodeJS.ErrnoException).code ?? 'not a real folder'}); nothing was stored.`);
    return 1;
  }
  io.out(`Stored a VM token for ${describe(account)}. Moe uses it only to run this account's agent jobs in a Moe VM.`);
  return 0;
}

function run(argv: string[], io: CliIo): number {
  const args = parseArgs(argv);
  const file = args.accountsFile ? path.resolve(args.accountsFile) : registryFilePath(io.env);
  switch (args.command) {
    case 'list': {
      const registry = readRegistry(file);
      if (!registry || registry.accounts.length === 0) {
        io.err(`No Claude accounts in ${file}. Add one with: add --label <name>`);
        return 0;
      }
      for (const account of registry.accounts) {
        io.out([account.id, account.label, account.signIn, accountConfigDir(file, account.id)].join('\t'));
      }
      return 0;
    }
    case 'add': {
      const account = addAccount(file, args.label);
      io.out(account.id);
      io.err(`Added ${describe(account)}. Next, sign it in: login ${account.id}`);
      return 0;
    }
    case 'login':
      return login(io, file, accountFor(file, args.positional[0]));
    case 'logout':
      return signOut(io, file, accountFor(file, args.positional[0]));
    case 'check': {
      const registry = readRegistry(file);
      const accounts = args.positional[0] ? [accountFor(file, args.positional[0])] : registry?.accounts ?? [];
      if (accounts.length === 0) {
        io.err(`No Claude accounts in ${file}.`);
        return 0;
      }
      let allSubscription = true;
      for (const account of accounts) {
        const state = check(io, file, account);
        if (state === 'not-found') {
          io.err(notFoundMessage(io));
          return 1;
        }
        io.out([account.id, account.label, state].join('\t'));
        if (state !== 'subscription') allSubscription = false;
      }
      return allSubscription ? 0 : 1;
    }
    case 'remove': {
      const account = accountFor(file, args.positional[0]);
      if (args.signOut) {
        const signedOut = signOut(io, file, account);
        if (signedOut !== 0) return signedOut;
      }
      removeAccount(file, account.id);
      io.out(`Removed ${describe(account)}. Its Claude folder stays at ${accountConfigDir(file, account.id)}; delete it yourself if you no longer need it.`);
      return 0;
    }
    case 'vm-token': {
      const account = accountFor(file, args.positional[0]);
      if (!args.remove) return vmToken(io, file, account);
      io.out(removeVmToken(file, account.id) ? `Removed the VM token for ${describe(account)}.` : `${describe(account)} has no VM token.`);
      return 0;
    }
    case undefined:
    case 'help':
      for (const line of USAGE) io.out(line);
      return args.command === undefined ? 2 : 0;
    default:
      throw new UsageError(`unknown command "${args.command}"`);
  }
}

/** Runs one command; returns the exit code (0 ok, 1 failed, 2 usage). */
export function runAccountsCli(argv: string[], io: CliIo = defaultIo): number {
  try {
    return run(argv, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`accounts: ${error.message}`);
      for (const line of USAGE) io.err(line);
      return 2;
    }
    io.err(error instanceof RegistryError ? error.message : `accounts: ${(error as Error).message}`);
    return 1;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return normalize(entry) === normalize(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) {
  process.exitCode = runAccountsCli(process.argv.slice(2));
}
