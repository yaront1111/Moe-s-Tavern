// =============================================================================
// Account store — which Claude subscription account each claude launch uses
// =============================================================================
//
// The registry (accounts/registry.ts) is the machine's account list; this
// module adds what the daemon learns at run time: usage per account, which
// account is active, and which seat runs on which account. Usage comes from
// the claude CLI's own reports (moe.report_account_usage) and is kept next to
// the registry in claude-usage/<id>.json, so every project's daemon on the
// machine sees the same numbers.
//
// Fill-first and sticky: a launch gets the active account while it is
// eligible, else the first eligible account in registry order. Eligible means
// signed in with a subscription, no live usage window at or past
// switchAtPercent (default 90), no blocking status and no pending refusal. A
// spent account comes back on its own when its window resets.
//
// A running worker moves at a step boundary: complete_step and start_step ask
// accountSwitchFor() and tell the worker to end its session, and the
// wrapper's relaunch of the held task leases again. Everyone else moves at
// their next launch.
//
// The daemon never runs claude and never opens a file inside a Claude config
// directory: it reads the registry and the usage files, and hands the wrapper
// a directory path.

import fs from 'fs';
import { fileURLToPath } from 'url';
import type { StateManager } from './StateManager.js';
import type { AccountRotationView, AccountView } from '../types/schema.js';
import { logger } from '../util/logger.js';
import {
  DEFAULT_SWITCH_AT_PERCENT,
  accountConfigDir,
  accountUsageFile,
  readRegistry,
  recordSignIn,
  registryFilePath,
  writeJsonAtomic,
  type Registry,
  type RegistryAccount,
} from '../accounts/registry.js';
import {
  blockedUntilMs,
  hitLimit,
  liveWindows,
  mergeSample,
  peakPercent,
  validateUsage,
  type AccountUsage,
  type ParsedWindow,
} from '../accounts/usageWindows.js';

/** The `accounts` CLI next to this build (dist/accounts/cli.js); the IDE runs sign-in through it. */
const CLI_SCRIPT = fileURLToPath(new URL('../accounts/cli.js', import.meta.url));
const WATCH_INTERVAL_MS = 2_000;

export type AccountLease =
  | { rotation: false; reason: string | null }
  | {
      rotation: true;
      accountId: string;
      label: string;
      configDir: string;
      peakPercent: number | null;
      switchAtPercent: number;
    }
  | { rotation: true; accountId: null; retryAt: string; retryInSec: number; switchAtPercent: number };

export interface AccountReport {
  workerId?: string;
  accountId: string;
  windows: Record<string, ParsedWindow>;
  refused: boolean;
  /** A wrapper probe found the account no longer signed in ("signed_out") or not on a subscription ("other"). */
  signIn?: 'signed_out' | 'other';
}

export interface AccountReportResult {
  recorded: boolean;
  blockedUntil: string | null;
  peakPercent: number | null;
}

export interface AccountSwitch {
  from: string;
  fromLabel: string;
  to: string;
  toLabel: string;
  fromPeakPercent: number | null;
  switchAtPercent: number;
  reason: 'usage' | 'limit' | 'signed_out' | 'removed';
}

interface RegistryRead {
  registry: Registry | null;
  error: string | null;
}

interface Fleet {
  registry: { key: string; value: RegistryRead } | null;
  usage: Map<string, { key: string; value: AccountUsage | null }>;
  /** The account launches stick to while it is eligible. */
  active: string | null;
  /** The "every account is spent" alert was posted this episode. */
  alerted: boolean;
  /** Account each seat's current launch was leased, in this daemon process only. Drives the step-boundary switch. */
  leases: Map<string, string>;
  lastViewKey: string | null;
}

const fleets = new WeakMap<StateManager, Fleet>();

function fleetOf(state: StateManager): Fleet {
  let fleet = fleets.get(state);
  if (!fleet) {
    fleet = { registry: null, usage: new Map(), active: null, alerted: false, leases: new Map(), lastViewKey: null };
    fleets.set(state, fleet);
  }
  return fleet;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Changes whenever the file is replaced (every write is a rename) or edited in place. */
function statKey(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

function loadRegistry(fleet: Fleet, file: string): RegistryRead {
  const key = `${file}|${statKey(file)}`;
  if (fleet.registry?.key !== key) {
    let value: RegistryRead;
    try {
      value = { registry: readRegistry(file), error: null };
    } catch (error) {
      value = { registry: null, error: (error as Error).message };
    }
    fleet.registry = { key, value };
  }
  return fleet.registry.value;
}

function readUsage(usageFile: string, id: string): AccountUsage | null {
  try {
    return validateUsage(JSON.parse(fs.readFileSync(usageFile, 'utf8')), id);
  } catch {
    return null;
  }
}

function loadUsage(fleet: Fleet, registryFile: string, id: string): AccountUsage | null {
  const usageFile = accountUsageFile(registryFile, id);
  const key = statKey(usageFile);
  const cached = fleet.usage.get(usageFile);
  if (cached?.key === key) return cached.value;
  const value = key === 'missing' ? null : readUsage(usageFile, id);
  fleet.usage.set(usageFile, { key, value });
  return value;
}

function usageBlockedUntil(fleet: Fleet, file: string, account: RegistryAccount, threshold: number, nowMs: number): number | null {
  const usage = loadUsage(fleet, file, account.id);
  return usage ? blockedUntilMs(usage, threshold, nowMs) : null;
}

function isEligible(fleet: Fleet, file: string, account: RegistryAccount, threshold: number, nowMs: number): boolean {
  return account.signIn === 'subscription' && usageBlockedUntil(fleet, file, account, threshold, nowMs) === null;
}

/** The account the next lease picks: the active one while eligible, else the first eligible in fill order. */
function choose(fleet: Fleet, file: string, registry: Registry, nowMs: number): string | null {
  const eligible = (account: RegistryAccount) => isEligible(fleet, file, account, registry.switchAtPercent, nowMs);
  const active = fleet.active === null ? undefined : registry.accounts.find((account) => account.id === fleet.active);
  if (active && eligible(active)) return active.id;
  return registry.accounts.find(eligible)?.id ?? null;
}

export function accountRotationView(state: StateManager, nowMs: number = Date.now()): AccountRotationView {
  const fleet = fleetOf(state);
  const file = registryFilePath();
  const { registry, error } = loadRegistry(fleet, file);
  const threshold = registry?.switchAtPercent ?? DEFAULT_SWITCH_AT_PERCENT;
  const next = registry ? choose(fleet, file, registry, nowMs) : null;
  const seats = new Map<string, string[]>();
  for (const worker of state.workers.values()) {
    if (worker.status === 'DEAD' || !worker.accountId) continue;
    seats.set(worker.accountId, [...(seats.get(worker.accountId) ?? []), worker.id]);
  }
  return {
    registryFile: file,
    switchAtPercent: threshold,
    error,
    cli: { node: process.execPath, script: CLI_SCRIPT },
    accounts: (registry?.accounts ?? []).map((account): AccountView => {
      const usage = loadUsage(fleet, file, account.id);
      const until = usage ? blockedUntilMs(usage, threshold, nowMs) : null;
      return {
        id: account.id,
        label: account.label,
        signIn: account.signIn,
        signInCheckedAt: account.signInCheckedAt,
        windows: usage ? liveWindows(usage, nowMs) : {},
        peakPercent: usage ? peakPercent(usage, nowMs) : null,
        blockedUntil: until === null ? null : iso(until),
        active: account.id === next,
        seats: (seats.get(account.id) ?? []).sort(),
      };
    }),
  };
}

/**
 * Broadcast ACCOUNTS_UPDATED when the view changed since the last broadcast.
 * Every change source funnels through here: this daemon's leases and reports,
 * the IDE's edits, the CLI's sign-ins, other projects' daemons writing usage,
 * and a window resetting with time (the watch timer).
 */
export function refreshAccounts(state: StateManager, nowMs: number = Date.now()): void {
  const fleet = fleetOf(state);
  const view = accountRotationView(state, nowMs);
  const key = JSON.stringify(view);
  if (key === fleet.lastViewKey) return;
  fleet.lastViewKey = key;
  state.emit({ type: 'ACCOUNTS_UPDATED', payload: view });
}

/** Watch the registry, the usage files and the clock; returns the stop function. */
export function startAccountWatch(state: StateManager, intervalMs: number = WATCH_INTERVAL_MS): () => void {
  fleetOf(state).lastViewKey = JSON.stringify(accountRotationView(state));
  const timer = setInterval(() => {
    try {
      refreshAccounts(state);
    } catch (error) {
      logger.warn({ error }, 'Account watch tick failed');
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Forget the cached registry, so the next read sees a write this process just made. */
export function invalidateAccountRegistry(state: StateManager): void {
  fleetOf(state).registry = null;
}

async function postGovernors(state: StateManager, message: string): Promise<void> {
  try {
    await state.postToRoleChannel('governors', message);
  } catch {
    /* best-effort */
  }
}

function labelOf(registry: Registry, id: string): string {
  const account = registry.accounts.find((entry) => entry.id === id);
  return account && account.label !== id ? `${account.label} (${id})` : id;
}

function switchReason(fleet: Fleet, file: string, registry: Registry, id: string, nowMs: number): AccountSwitch['reason'] {
  const account = registry.accounts.find((entry) => entry.id === id);
  if (!account) return 'removed';
  if (account.signIn !== 'subscription') return 'signed_out';
  const usage = loadUsage(fleet, file, id);
  return usage && hitLimit(usage, nowMs) ? 'limit' : 'usage';
}

async function settleLease(state: StateManager, fleet: Fleet, workerId: string, accountId: string | null, nowMs: number): Promise<void> {
  if (accountId === null) fleet.leases.delete(workerId);
  else fleet.leases.set(workerId, accountId);
  if ((state.getWorker(workerId)?.accountId ?? null) !== accountId) {
    await state.touchWorker(workerId, { accountId });
  }
  refreshAccounts(state, nowMs);
}

/**
 * Pick the account this seat's next claude launch runs under. rotation:false
 * means "launch the way you always did" (no accounts, none signed in, or an
 * unusable registry); accountId null means every signed-in account is spent.
 */
export async function leaseAccount(state: StateManager, workerId: string, nowMs: number = Date.now()): Promise<AccountLease> {
  const fleet = fleetOf(state);
  const file = registryFilePath();
  const { registry, error } = loadRegistry(fleet, file);
  if (error !== null) {
    await settleLease(state, fleet, workerId, null, nowMs);
    return { rotation: false, reason: `the Claude account list cannot be used (${error})` };
  }
  if (!registry || registry.accounts.length === 0) {
    await settleLease(state, fleet, workerId, null, nowMs);
    return { rotation: false, reason: null };
  }
  const threshold = registry.switchAtPercent;
  const signedIn = registry.accounts.filter((account) => account.signIn === 'subscription');
  if (signedIn.length === 0) {
    await settleLease(state, fleet, workerId, null, nowMs);
    return {
      rotation: false,
      reason: `none of the ${registry.accounts.length} Claude accounts is signed in with a subscription (Moe tool window > Accounts > Sign in)`,
    };
  }

  const chosen = choose(fleet, file, registry, nowMs);
  if (chosen === null) {
    const retryAtMs = Math.min(...signedIn.map((account) => usageBlockedUntil(fleet, file, account, threshold, nowMs) ?? nowMs));
    const retryAt = iso(retryAtMs);
    const retryInSec = Math.max(1, Math.ceil((retryAtMs - nowMs) / 1000));
    fleet.active = null;
    if (!fleet.alerted) {
      fleet.alerted = true;
      const ids = signedIn.map((account) => account.id);
      state.appendActivity('ACCOUNTS_EXHAUSTED', { workerId, accounts: ids, retryAt, switchAtPercent: threshold });
      await postGovernors(state, `⏸️ Every signed-in Claude account (${ids.map((id) => labelOf(registry, id)).join(', ')}) is at its usage limit (switch at ${threshold}%). Claude seats wait until ${retryAt}.`);
    }
    await settleLease(state, fleet, workerId, null, nowMs);
    return { rotation: true, accountId: null, retryAt, retryInSec, switchAtPercent: threshold };
  }

  fleet.alerted = false;
  const previous = fleet.active;
  fleet.active = chosen;
  if (previous !== null && previous !== chosen) {
    const fromUsage = loadUsage(fleet, file, previous);
    const fromPeak = fromUsage ? peakPercent(fromUsage, nowMs) : null;
    const reason = switchReason(fleet, file, registry, previous, nowMs);
    state.appendActivity('ACCOUNT_SWITCHED', { workerId, from: previous, to: chosen, fromPeakPercent: fromPeak, switchAtPercent: threshold, reason });
    await postGovernors(state, `🔁 Claude seats move from ${labelOf(registry, previous)} to ${labelOf(registry, chosen)}: ${
      reason === 'usage' ? `${previous} reached ${fromPeak ?? '?'}% (switch at ${threshold}%)`
        : reason === 'limit' ? `${previous} hit its usage limit`
          : reason === 'signed_out' ? `${previous} is no longer signed in with a subscription`
            : `${previous} was removed`
    }.`);
  }
  const account = registry.accounts.find((entry) => entry.id === chosen)!;
  const usage = loadUsage(fleet, file, chosen);
  await settleLease(state, fleet, workerId, chosen, nowMs);
  return {
    rotation: true,
    accountId: chosen,
    label: account.label,
    configDir: accountConfigDir(file, chosen),
    peakPercent: usage ? peakPercent(usage, nowMs) : null,
    switchAtPercent: threshold,
  };
}

/** Merge one usage report (and an optional sign-in finding) into the account. Unknown ids are ignored, never created. */
export async function recordAccountReport(state: StateManager, report: AccountReport, nowMs: number = Date.now()): Promise<AccountReportResult> {
  const fleet = fleetOf(state);
  const file = registryFilePath();
  const { registry } = loadRegistry(fleet, file);
  const account = registry?.accounts.find((entry) => entry.id === report.accountId);
  if (!registry || !account) return { recorded: false, blockedUntil: null, peakPercent: null };
  const threshold = registry.switchAtPercent;
  let recorded = false;

  if (report.signIn !== undefined && report.signIn !== account.signIn) {
    recordSignIn(file, account.id, report.signIn, nowMs);
    fleet.registry = null;
    recorded = true;
    state.appendActivity('ACCOUNT_SIGNED_OUT', { accountId: account.id, state: report.signIn, workerId: report.workerId ?? null });
    await postGovernors(state, `🔑 Claude account ${labelOf(registry, account.id)} is ${
      report.signIn === 'other' ? 'no longer signed in with a Claude subscription' : 'signed out'
    }. Sign it in again in the Moe tool window (Accounts); seats use the next account meanwhile.`);
  }

  // Read fresh, not from the cache: another project's daemon may have written it a moment ago.
  const usageFile = accountUsageFile(file, account.id);
  const { usage, changed } = mergeSample(
    readUsage(usageFile, account.id),
    account.id,
    { windows: report.windows, refused: report.refused },
    threshold,
    nowMs
  );
  if (changed) {
    writeJsonAtomic(usageFile, usage);
    fleet.usage.delete(usageFile);
    recorded = true;
  }
  refreshAccounts(state, nowMs);
  const until = blockedUntilMs(usage, threshold, nowMs);
  return { recorded, blockedUntil: until === null ? null : iso(until), peakPercent: peakPercent(usage, nowMs) };
}

/**
 * A switch is due when the seat's leased account is no longer eligible (spent,
 * refused, signed out or removed) and the next lease would pick another one.
 * Only leases made by this daemon process count, so a restart or a seat that
 * never leased (rotation off, another CLI) is never told to switch.
 */
export function accountSwitchFor(state: StateManager, workerId: string | undefined, nowMs: number = Date.now()): AccountSwitch | null {
  const fleet = fleets.get(state);
  const from = workerId ? fleet?.leases.get(workerId) : undefined;
  if (!fleet || !from) return null;
  const file = registryFilePath();
  const { registry } = loadRegistry(fleet, file);
  if (!registry) return null;
  const threshold = registry.switchAtPercent;
  const current = registry.accounts.find((account) => account.id === from);
  if (current && isEligible(fleet, file, current, threshold, nowMs)) return null;
  const to = choose(fleet, file, registry, nowMs);
  if (to === null || to === from) return null;
  const usage = loadUsage(fleet, file, from);
  return {
    from,
    fromLabel: current?.label ?? from,
    to,
    toLabel: registry.accounts.find((account) => account.id === to)!.label,
    fromPeakPercent: usage ? peakPercent(usage, nowMs) : null,
    switchAtPercent: threshold,
    reason: switchReason(fleet, file, registry, from, nowMs),
  };
}

/** The first sentence of every ACCOUNT-SWITCH instruction. */
export function accountSwitchCause(change: AccountSwitch): string {
  switch (change.reason) {
    case 'usage':
      return `Claude account ${change.fromLabel} is at ${change.fromPeakPercent ?? '?'}% of its usage limit (Moe switches at ${change.switchAtPercent}%)`;
    case 'limit':
      return `Claude account ${change.fromLabel} hit its usage limit`;
    case 'signed_out':
      return `Claude account ${change.fromLabel} is no longer signed in with a subscription`;
    case 'removed':
      return `Claude account ${change.fromLabel} was removed from Moe's account list`;
  }
}
