// =============================================================================
// Claude account registry: the machine-level list of Claude subscription
// accounts that Moe rotates claude launches across.
// =============================================================================
//
// One JSON file per machine (MOE_ACCOUNTS_FILE, else ~/.moe/claude-accounts.json),
// shared by every project's daemon and by the `accounts` CLI (accounts/cli.ts).
// Each account is a Claude config directory next to the file
// (claude-accounts/<id>) that Claude's own `claude auth login` signs in. Moe only
// creates that directory and hands its path to claude as CLAUDE_CONFIG_DIR:
// nothing here, or anywhere in Moe, opens a file inside it.
//
// Every mutation re-reads the file, applies one change and writes it back
// atomically (tmp + rename), so the daemons and the CLI never tear it. Two
// writers inside the same millisecond can still lose one change; the next
// edit or sign-in check repairs it.
//
// Pure fs and no logger, so cli.ts can import this module and run under any
// node, including WSL's node over a /mnt path.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { escapeJsonForFile } from '../util/atomicWrite.js';

export const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MAX_ACCOUNTS = 32;
export const MAX_LABEL_LENGTH = 64;
export const DEFAULT_SWITCH_AT_PERCENT = 90;
export const SIGN_IN_STATES = ['subscription', 'signed_out', 'other'] as const;
export type SignInState = (typeof SIGN_IN_STATES)[number];

/** Credentials that outrank a claude.ai login in claude's auth order; removed from every account-bound claude process. */
export const TOKEN_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
/** Cloud-provider switches: with one set, claude ignores logins entirely. */
export const PROVIDER_ENV = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const;

export interface RegistryAccount {
  id: string;
  label: string;
  /** Only "subscription" accounts are ever leased. New accounts start "signed_out". */
  signIn: SignInState;
  signInCheckedAt: string | null;
}

export interface Registry {
  version: 1;
  /** Leave an account once any live usage window reaches this percent (1-100). */
  switchAtPercent: number;
  /** Fill order. */
  accounts: RegistryAccount[];
}

/** A registry problem, carrying the token the CLI prints (MOE_ACCOUNT_*). */
export class RegistryError extends Error {
  constructor(readonly token: string, detail: string) {
    super(`${token}: ${detail}`);
    this.name = 'RegistryError';
  }
}

const REGISTRY_KEYS = new Set(['version', 'switchAtPercent', 'accounts']);
const ACCOUNT_KEYS = new Set(['id', 'label', 'signIn', 'signInCheckedAt']);
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export function registryFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MOE_ACCOUNTS_FILE?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.moe', 'claude-accounts.json');
}

/** The account's Claude config directory. Moe creates it and passes its path to claude; it never reads inside it. */
export function accountConfigDir(registryFile: string, id: string): string {
  return path.join(path.dirname(registryFile), 'claude-accounts', id);
}

/** Usage numbers the daemons learned for the account (state/accountStore.ts). No credential, no path. */
export function accountUsageFile(registryFile: string, id: string): string {
  return path.join(path.dirname(registryFile), 'claude-usage', `${id}.json`);
}

export function emptyRegistry(): Registry {
  return { version: 1, switchAtPercent: DEFAULT_SWITCH_AT_PERCENT, accounts: [] };
}

function invalid(file: string, detail: string): RegistryError {
  return new RegistryError('MOE_ACCOUNT_REGISTRY_INVALID', `${file}: ${detail}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Unknown keys make the file invalid: a stray "dir" or "token" must surface, not ride along. */
export function validateRegistry(raw: unknown, file: string): Registry {
  if (!isPlainObject(raw)) throw invalid(file, 'must be a JSON object');
  const extra = Object.keys(raw).find((key) => !REGISTRY_KEYS.has(key));
  if (extra !== undefined) throw invalid(file, `unknown key "${extra}"`);
  if (raw.version !== 1) throw invalid(file, 'version must be 1');
  const percent = raw.switchAtPercent ?? DEFAULT_SWITCH_AT_PERCENT;
  if (!Number.isInteger(percent) || (percent as number) < 1 || (percent as number) > 100) {
    throw invalid(file, 'switchAtPercent must be a whole number from 1 to 100');
  }
  const list = raw.accounts ?? [];
  if (!Array.isArray(list)) throw invalid(file, 'accounts must be an array');
  if (list.length > MAX_ACCOUNTS) throw invalid(file, `at most ${MAX_ACCOUNTS} accounts`);
  const seen = new Set<string>();
  const accounts = list.map((entry: unknown, index): RegistryAccount => {
    if (!isPlainObject(entry)) throw invalid(file, `accounts[${index}] must be an object`);
    const extraKey = Object.keys(entry).find((key) => !ACCOUNT_KEYS.has(key));
    if (extraKey !== undefined) throw invalid(file, `accounts[${index}] has unknown key "${extraKey}"`);
    const id = entry.id;
    if (typeof id !== 'string' || !ACCOUNT_ID_RE.test(id)) {
      throw invalid(file, `accounts[${index}].id must be 1-64 letters, digits, "_" or "-"`);
    }
    if (seen.has(id)) throw invalid(file, `duplicate account id "${id}"`);
    seen.add(id);
    let label: string;
    try {
      label = normalizeLabel(entry.label, id);
    } catch (error) {
      throw invalid(file, `accounts[${index}].label: ${(error as Error).message}`);
    }
    const signIn = entry.signIn ?? 'signed_out';
    if (!SIGN_IN_STATES.includes(signIn as SignInState)) {
      throw invalid(file, `accounts[${index}].signIn must be one of ${SIGN_IN_STATES.join(', ')}`);
    }
    const checkedAt = entry.signInCheckedAt ?? null;
    if (checkedAt !== null && (typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt)))) {
      throw invalid(file, `accounts[${index}].signInCheckedAt must be an ISO time or null`);
    }
    return { id, label, signIn: signIn as SignInState, signInCheckedAt: checkedAt };
  });
  return { version: 1, switchAtPercent: percent as number, accounts };
}

/** null when the file does not exist; throws RegistryError when it exists but cannot be used. */
export function readRegistry(file: string): Registry | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw invalid(file, `cannot read it (${(error as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw invalid(file, `not valid JSON (${(error as Error).message})`);
  }
  return validateRegistry(raw, file);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write JSON through a temp file and a rename, so a reader never sees half a
 * file. Windows refuses the rename for a moment while another process has the
 * target open (EPERM/EBUSY/EACCES); retry briefly before giving up.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, escapeJsonForFile(JSON.stringify(value, null, 2)) + '\n', { mode: 0o600 });
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        fs.rmSync(tmp, { force: true });
        throw error;
      }
      sleepSync(25 * attempt);
    }
  }
}

/** Read fresh, apply one change, write back. `change` returns false to skip the write (nothing changed). */
export function updateRegistry(file: string, change: (registry: Registry) => boolean | void): Registry {
  const registry = readRegistry(file) ?? emptyRegistry();
  if (change(registry) === false) return registry;
  writeJsonAtomic(file, validateRegistry(registry, file));
  return registry;
}

export function findAccount(registry: Registry, id: string): RegistryAccount {
  const account = registry.accounts.find((entry) => entry.id === id);
  if (!account) throw new RegistryError('MOE_ACCOUNT_UNKNOWN', `no Claude account "${id}" is registered`);
  return account;
}

/** Trimmed label; empty or missing falls back to the id. */
export function normalizeLabel(label: unknown, fallback: string): string {
  if (label === undefined || label === null) return fallback;
  if (typeof label !== 'string') throw new RegistryError('MOE_ACCOUNT_LABEL_INVALID', 'the label must be text');
  const trimmed = label.trim();
  if (!trimmed) return fallback;
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new RegistryError('MOE_ACCOUNT_LABEL_INVALID', `the label is longer than ${MAX_LABEL_LENGTH} characters`);
  }
  if (CONTROL_CHARS_RE.test(trimmed)) {
    throw new RegistryError('MOE_ACCOUNT_LABEL_INVALID', 'the label contains control characters');
  }
  return trimmed;
}

/**
 * Register a new, signed-out account. Its id is the lowest free acct-<n> whose
 * config directory does not exist yet (an existence check only), so a new
 * account never inherits the login a removed account left behind.
 */
export function addAccount(file: string, label?: unknown): RegistryAccount {
  let added: RegistryAccount | null = null;
  updateRegistry(file, (registry) => {
    if (registry.accounts.length >= MAX_ACCOUNTS) {
      throw new RegistryError('MOE_ACCOUNT_LIMIT', `at most ${MAX_ACCOUNTS} accounts can be registered`);
    }
    const taken = new Set(registry.accounts.map((account) => account.id));
    let n = 1;
    while (taken.has(`acct-${n}`) || fs.existsSync(accountConfigDir(file, `acct-${n}`))) n++;
    const id = `acct-${n}`;
    added = { id, label: normalizeLabel(label, id), signIn: 'signed_out', signInCheckedAt: null };
    fs.rmSync(accountUsageFile(file, id), { force: true });
    registry.accounts.push(added);
  });
  return added!;
}

/** Unregister an account. Its config directory, and the login inside it, stay where they are. */
export function removeAccount(file: string, id: string): RegistryAccount {
  let removed: RegistryAccount | null = null;
  updateRegistry(file, (registry) => {
    removed = findAccount(registry, id);
    registry.accounts = registry.accounts.filter((account) => account.id !== id);
  });
  fs.rmSync(accountUsageFile(file, id), { force: true });
  return removed!;
}

/** Move an account one place up (-1) or down (+1) in the fill order. */
export function moveAccount(file: string, id: string, offset: -1 | 1): void {
  updateRegistry(file, (registry) => {
    findAccount(registry, id);
    const from = registry.accounts.findIndex((account) => account.id === id);
    const to = from + offset;
    if (to < 0 || to >= registry.accounts.length) return false;
    const [account] = registry.accounts.splice(from, 1);
    registry.accounts.splice(to, 0, account);
  });
}

export function renameAccount(file: string, id: string, label: unknown): void {
  updateRegistry(file, (registry) => {
    const account = findAccount(registry, id);
    account.label = normalizeLabel(label, id);
  });
}

export function setSwitchAtPercent(file: string, percent: number): void {
  updateRegistry(file, (registry) => {
    registry.switchAtPercent = percent;
  });
}

/** Record the result of a sign-in check. Returns null when the account is no longer registered. */
export function recordSignIn(file: string, id: string, signIn: SignInState, nowMs: number = Date.now()): RegistryAccount | null {
  let updated: RegistryAccount | null = null;
  updateRegistry(file, (registry) => {
    const account = registry.accounts.find((entry) => entry.id === id);
    if (!account) return false;
    account.signIn = signIn;
    account.signInCheckedAt = new Date(nowMs).toISOString();
    updated = { ...account };
  });
  return updated;
}
