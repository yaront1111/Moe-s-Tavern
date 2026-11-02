import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from './StateManager.js';
import {
  accountRotationView,
  accountSwitchFor,
  invalidateAccountRegistry,
  leaseAccount,
  recordAccountReport,
  refreshAccounts,
} from './accountStore.js';
import {
  accountConfigDir,
  accountUsageFile,
  addAccount,
  moveAccount,
  readRegistry,
  recordSignIn,
  registryFilePath,
  removeAccount,
  renameAccount,
  vmTokenFile,
} from '../accounts/registry.js';
import { parseUsageWindows } from '../accounts/usageWindows.js';
import { removeVmToken, writeVmToken } from '../accounts/vmTokens.js';
import type { Project, Worker } from '../types/schema.js';

// What the daemon does with the machine's account list: which account each
// claude launch gets, when a seat must move, and what the IDE is shown.

/** Set by vitest.config.ts before any test file loads. */
const VITEST_ACCOUNTS_FILE = process.env.MOE_ACCOUNTS_FILE;

const T0 = Date.parse('2026-10-20T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 3_600_000;

let testDir: string;
let accountsFile: string;
let state: StateManager;
let posts: string[];
let activity: Array<{ event: string; payload: Record<string, unknown> }>;

function writeWorker(projectDir: string, id: string): void {
  const now = new Date().toISOString();
  const worker: Worker = {
    id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1', currentTaskId: null, status: 'IDLE',
    teamId: null, branch: 'main', modifiedFiles: [], startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0,
  };
  fs.writeFileSync(path.join(projectDir, '.moe', 'workers', `${id}.json`), JSON.stringify(worker, null, 2));
}

async function newState(projectDir: string, workerIds: string[] = []): Promise<StateManager> {
  const moePath = path.join(projectDir, '.moe');
  for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'teams', 'channels', 'messages']) {
    fs.mkdirSync(path.join(moePath, sub), { recursive: true });
  }
  const project: Partial<Project> = {
    id: 'proj-test', schemaVersion: 6, name: 'Test', rootPath: projectDir,
    globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
    settings: {
      approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false,
      branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
    } as Project['settings'],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
  for (const id of workerIds) writeWorker(projectDir, id);
  const loaded = new StateManager({ projectPath: projectDir });
  await loaded.load();
  vi.spyOn(loaded, 'postToRoleChannel').mockImplementation(async (_role, content) => {
    posts.push(content);
  });
  vi.spyOn(loaded, 'appendActivity').mockImplementation(((event: string, payload: Record<string, unknown>) => {
    activity.push({ event, payload });
  }) as StateManager['appendActivity']);
  return loaded;
}

/** acct-1 signed out, acct-2 and acct-3 on a subscription: the usual fixture. */
function threeAccounts(): void {
  addAccount(accountsFile, 'One');
  addAccount(accountsFile, 'Two');
  addAccount(accountsFile, 'Three');
  recordSignIn(accountsFile, 'acct-2', 'subscription', T0);
  recordSignIn(accountsFile, 'acct-3', 'subscription', T0);
}

function usage(percent: number, nowMs: number, resetInMs = 2 * HOUR) {
  return parseUsageWindows({ five_hour: { percent, resetsAt: Math.floor((nowMs + resetInMs) / 1000) } }, nowMs);
}

function report(accountId: string, windows: ReturnType<typeof usage>, nowMs: number, extra: { refused?: boolean; signIn?: 'signed_out' | 'other'; workerId?: string } = {}) {
  return recordAccountReport(state, { workerId: extra.workerId ?? 'w1', accountId, windows, refused: extra.refused ?? false, signIn: extra.signIn }, nowMs);
}

beforeEach(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-account-store-'));
  accountsFile = path.join(testDir, 'machine', 'claude-accounts.json');
  process.env.MOE_ACCOUNTS_FILE = accountsFile;
  posts = [];
  activity = [];
  state = await newState(path.join(testDir, 'project'), ['w1', 'w2', 'w3']);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (VITEST_ACCOUNTS_FILE === undefined) delete process.env.MOE_ACCOUNTS_FILE;
  else process.env.MOE_ACCOUNTS_FILE = VITEST_ACCOUNTS_FILE;
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('test isolation', () => {
  it('points every test at a temp list, never at the developer\'s real one', () => {
    expect(VITEST_ACCOUNTS_FILE).toContain('moe-vitest-no-accounts');
    expect(registryFilePath()).toBe(path.resolve(accountsFile));
  });
});

describe('leaseAccount', () => {
  it('launches as before when there is no list, no account, or no signed-in account', async () => {
    expect(await leaseAccount(state, 'w1', T0)).toEqual({ rotation: false, reason: null });
    addAccount(accountsFile);
    addAccount(accountsFile);
    invalidateAccountRegistry(state);
    const lease = await leaseAccount(state, 'w1', T0);
    expect(lease).toMatchObject({ rotation: false });
    expect(lease.rotation === false && lease.reason).toContain('none of the 2 Claude accounts is signed in');
    expect(state.getWorker('w1')?.accountId ?? null).toBeNull();
  });

  it('launches as before, with the reason, when the list cannot be used', async () => {
    fs.mkdirSync(path.dirname(accountsFile), { recursive: true });
    fs.writeFileSync(accountsFile, JSON.stringify({ version: 1, accounts: [{ id: 'acct-1', token: 'x' }] }));
    const lease = await leaseAccount(state, 'w1', T0);
    expect(lease.rotation).toBe(false);
    expect(lease.rotation === false && lease.reason).toMatch(/cannot be used .*MOE_ACCOUNT_REGISTRY_INVALID/);
    expect(accountRotationView(state, T0).error).toContain('unknown key "token"');
  });

  it('fills the first signed-in account and sticks to it while it is eligible', async () => {
    threeAccounts();
    expect(await leaseAccount(state, 'w1', T0)).toEqual({
      rotation: true, accountId: 'acct-2', label: 'Two', configDir: accountConfigDir(accountsFile, 'acct-2'),
      peakPercent: null, switchAtPercent: 90,
    });
    moveAccount(accountsFile, 'acct-3', -1);
    recordSignIn(accountsFile, 'acct-1', 'subscription', T0);
    // acct-1 now comes first and acct-3 before acct-2, but the active account is still eligible.
    expect(await leaseAccount(state, 'w2', T0)).toMatchObject({ accountId: 'acct-2' });
    expect(state.getWorker('w1')?.accountId).toBe('acct-2');
    const view = accountRotationView(state, T0);
    expect(view.accounts.map((entry) => [entry.id, entry.active, entry.seats])).toEqual([
      ['acct-1', false, []],
      ['acct-3', false, []],
      ['acct-2', true, ['w1', 'w2']],
    ]);
    expect(activity.filter((entry) => entry.event === 'ACCOUNT_SWITCHED')).toEqual([]);
  });

  it('moves launches to the next account once the active one reaches the switch percent', async () => {
    threeAccounts();
    await leaseAccount(state, 'w1', T0);
    await report('acct-2', usage(89, T0), T0);
    expect(await leaseAccount(state, 'w2', T0 + MIN)).toMatchObject({ accountId: 'acct-2', peakPercent: 89 });

    const result = await report('acct-2', usage(91.5, T0 + 2 * MIN, 2 * HOUR - 2 * MIN), T0 + 2 * MIN);
    expect(result).toEqual({ recorded: true, blockedUntil: new Date(T0 + 2 * HOUR).toISOString(), peakPercent: 91.5 });
    expect(await leaseAccount(state, 'w3', T0 + 3 * MIN)).toMatchObject({ accountId: 'acct-3', label: 'Three' });
    expect(activity.filter((entry) => entry.event === 'ACCOUNT_SWITCHED').map((entry) => entry.payload)).toEqual([
      { workerId: 'w3', from: 'acct-2', to: 'acct-3', fromPeakPercent: 91.5, switchAtPercent: 90, reason: 'usage' },
    ]);
    expect(posts).toEqual(['🔁 Claude seats move from Two (acct-2) to Three (acct-3): acct-2 reached 91.5% (switch at 90%).']);

    // The window resets: acct-2 is eligible again, but launches stay on acct-3.
    expect(await leaseAccount(state, 'w1', T0 + 3 * HOUR)).toMatchObject({ accountId: 'acct-3' });
  });

  it('waits when every signed-in account is spent, alerting once per episode', async () => {
    threeAccounts();
    await report('acct-2', usage(95, T0, 2 * HOUR), T0);
    await report('acct-3', usage(97, T0, HOUR), T0);
    const lease = await leaseAccount(state, 'w1', T0);
    expect(lease).toEqual({
      rotation: true, accountId: null, retryAt: new Date(T0 + HOUR).toISOString(), retryInSec: 3600, switchAtPercent: 90,
    });
    await leaseAccount(state, 'w2', T0 + MIN);
    expect(activity.filter((entry) => entry.event === 'ACCOUNTS_EXHAUSTED')).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/^⏸️ Every signed-in Claude account \(Two \(acct-2\), Three \(acct-3\)\) is at its usage limit/);
    expect(state.getWorker('w1')?.accountId ?? null).toBeNull();

    // acct-3's window resets first.
    expect(await leaseAccount(state, 'w1', T0 + HOUR + MIN)).toMatchObject({ accountId: 'acct-3' });
    await report('acct-3', usage(99, T0 + HOUR + 2 * MIN), T0 + HOUR + 2 * MIN);
    await leaseAccount(state, 'w1', T0 + HOUR + 3 * MIN);
    expect(activity.filter((entry) => entry.event === 'ACCOUNTS_EXHAUSTED')).toHaveLength(2);
  });

  it('skips an account whose launch was refused at its limit', async () => {
    threeAccounts();
    await leaseAccount(state, 'w1', T0);
    expect(await report('acct-2', {}, T0, { refused: true })).toMatchObject({ recorded: true, blockedUntil: new Date(T0 + HOUR).toISOString() });
    expect(accountSwitchFor(state, 'w1', T0 + MIN)).toMatchObject({ from: 'acct-2', to: 'acct-3', reason: 'limit' });
    await leaseAccount(state, 'w1', T0 + MIN);
    expect(posts).toEqual(['🔁 Claude seats move from Two (acct-2) to Three (acct-3): acct-2 hit its usage limit.']);
  });
});

describe('recordAccountReport', () => {
  it('takes a signed-out account out of rotation and says so once', async () => {
    threeAccounts();
    await leaseAccount(state, 'w1', T0);
    expect(await report('acct-2', {}, T0, { signIn: 'signed_out' })).toEqual({ recorded: true, blockedUntil: null, peakPercent: null });
    expect(readRegistry(accountsFile)!.accounts[1]).toMatchObject({ id: 'acct-2', signIn: 'signed_out' });
    expect(activity.filter((entry) => entry.event === 'ACCOUNT_SIGNED_OUT').map((entry) => entry.payload)).toEqual([
      { accountId: 'acct-2', state: 'signed_out', workerId: 'w1' },
    ]);
    expect(posts).toEqual([expect.stringMatching(/^🔑 Claude account Two \(acct-2\) is signed out\./)]);
    expect(accountSwitchFor(state, 'w1', T0)).toMatchObject({ from: 'acct-2', to: 'acct-3', reason: 'signed_out' });

    expect(await report('acct-2', {}, T0, { signIn: 'signed_out' })).toMatchObject({ recorded: false });
    expect(posts).toHaveLength(1);
  });

  it('ignores an account that is not registered, and writes nothing for it', async () => {
    threeAccounts();
    expect(await report('acct-9', usage(50, T0), T0)).toEqual({ recorded: false, blockedUntil: null, peakPercent: null });
    expect(fs.existsSync(accountUsageFile(accountsFile, 'acct-9'))).toBe(false);
  });

  it('writes the usage file only when a window moves materially', async () => {
    threeAccounts();
    expect((await report('acct-2', usage(40, T0), T0)).recorded).toBe(true);
    expect((await report('acct-2', usage(40.4, T0 + MIN), T0 + MIN)).recorded).toBe(false);
    expect(JSON.parse(fs.readFileSync(accountUsageFile(accountsFile, 'acct-2'), 'utf8'))).toMatchObject({
      id: 'acct-2', refusedUntil: null, windows: { five_hour: { percent: 40 } },
    });
  });

  it('shares usage with every daemon on the machine', async () => {
    threeAccounts();
    const other = await newState(path.join(testDir, 'other-project'), ['w9']);
    expect(await leaseAccount(other, 'w9', T0)).toMatchObject({ accountId: 'acct-2' });
    await report('acct-2', usage(93, T0), T0);
    expect(await leaseAccount(other, 'w9', T0 + MIN)).toMatchObject({ accountId: 'acct-3' });
    expect(accountRotationView(other, T0 + MIN).accounts.find((entry) => entry.id === 'acct-2')?.peakPercent).toBe(93);
  });
});

describe('accountSwitchFor', () => {
  it('is due only for a seat this daemon leased an account that is no longer eligible', async () => {
    threeAccounts();
    expect(accountSwitchFor(state, 'w1', T0)).toBeNull();
    await leaseAccount(state, 'w1', T0);
    expect(accountSwitchFor(state, 'w1', T0)).toBeNull();
    expect(accountSwitchFor(state, undefined, T0)).toBeNull();

    await report('acct-2', usage(90, T0), T0);
    expect(accountSwitchFor(state, 'w1', T0)).toEqual({
      from: 'acct-2', fromLabel: 'Two', to: 'acct-3', toLabel: 'Three', fromPeakPercent: 90, switchAtPercent: 90, reason: 'usage',
    });
    expect(accountSwitchFor(state, 'w2', T0)).toBeNull(); // w2 never leased
  });

  it('is not due when there is nowhere to go', async () => {
    addAccount(accountsFile, 'Only');
    recordSignIn(accountsFile, 'acct-1', 'subscription', T0);
    await leaseAccount(state, 'w1', T0);
    await report('acct-1', usage(99, T0), T0);
    expect(accountSwitchFor(state, 'w1', T0)).toBeNull();
  });

  it('moves a seat off an account that was removed', async () => {
    threeAccounts();
    await leaseAccount(state, 'w1', T0);
    removeAccount(accountsFile, 'acct-2');
    expect(accountSwitchFor(state, 'w1', T0)).toMatchObject({ from: 'acct-2', fromLabel: 'acct-2', to: 'acct-3', reason: 'removed' });
  });

  it('forgets a lease when the seat next launches without rotation', async () => {
    threeAccounts();
    await leaseAccount(state, 'w1', T0);
    fs.writeFileSync(accountsFile, '{');
    await leaseAccount(state, 'w1', T0);
    fs.rmSync(accountsFile);
    threeAccounts();
    await report('acct-2', usage(95, T0), T0, { workerId: 'w2' }); // another seat on that account
    expect(accountSwitchFor(state, 'w1', T0)).toBeNull();
  });

  it('learns a seat\'s account back from its own report after a restart, and never replaces a lease', async () => {
    threeAccounts();
    await report('acct-2', usage(40, T0), T0);
    expect(state.getWorker('w1')?.accountId).toBe('acct-2');
    expect(accountRotationView(state, T0).accounts[1]?.seats).toEqual(['w1']);
    await report('acct-3', usage(30, T0), T0); // not the account w1 runs on
    expect(state.getWorker('w1')?.accountId).toBe('acct-2');
    await report('acct-2', usage(92, T0), T0);
    expect(accountSwitchFor(state, 'w1', T0)).toMatchObject({ from: 'acct-2', to: 'acct-3', reason: 'usage' });
  });
});

describe('views', () => {
  it('shows each account with its live windows, seats, and the CLI the IDE runs', async () => {
    threeAccounts();
    await leaseAccount(state, 'w1', T0);
    await report('acct-2', usage(42, T0), T0);
    const view = accountRotationView(state, T0);
    expect(view.registryFile).toBe(path.resolve(accountsFile));
    expect(view.switchAtPercent).toBe(90);
    expect(view.error).toBeNull();
    expect(view.cli.node).toBe(process.execPath);
    expect(view.cli.script).toMatch(/accounts[\\/]cli\.js$/);
    expect(view.accounts[1]).toEqual({
      id: 'acct-2', label: 'Two', signIn: 'subscription', signInCheckedAt: new Date(T0).toISOString(),
      windows: { five_hour: { percent: 42, resetsAt: new Date(T0 + 2 * HOUR).toISOString() } },
      peakPercent: 42, blockedUntil: null, active: true, seats: ['w1'], vmToken: false,
    });
    expect(state.getSnapshot().accountRotation.accounts).toHaveLength(3);
  });

  it('reports VM token presence from a stat, never reading the token store', () => {
    threeAccounts();
    writeVmToken(accountsFile, 'acct-1', `sk-ant-oat01-${'Q7x_Lm2-Zp9K'.repeat(4)}`);
    try {
      fs.symlinkSync(vmTokenFile(accountsFile, 'acct-1'), vmTokenFile(accountsFile, 'acct-3'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    const spies = [vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs, 'openSync')];
    expect(accountRotationView(state, T0).accounts.map((account) => account.vmToken)).toEqual([true, false, false]);
    const opened = spies.flatMap((spy) => spy.mock.calls.map(([target]) => String(target)));
    expect(opened).toContain(path.resolve(accountsFile));
    expect(opened.filter((target) => target.includes('claude-vm-tokens'))).toEqual([]);
    removeVmToken(accountsFile, 'acct-1');
    expect(accountRotationView(state, T0).accounts[0].vmToken).toBe(false);
  });

  it('broadcasts ACCOUNTS_UPDATED only when the view changes', async () => {
    threeAccounts();
    const emit = vi.spyOn(state, 'emit');
    const updates = () => emit.mock.calls.filter(([event]) => event.type === 'ACCOUNTS_UPDATED').length;
    refreshAccounts(state, T0);
    refreshAccounts(state, T0);
    expect(updates()).toBe(1);
    renameAccount(accountsFile, 'acct-3', 'Third');
    invalidateAccountRegistry(state);
    refreshAccounts(state, T0);
    expect(updates()).toBe(2);
    // A window resetting changes the view with no write at all.
    await report('acct-2', usage(30, T0, HOUR), T0);
    expect(updates()).toBe(3);
    refreshAccounts(state, T0 + 2 * HOUR);
    expect(updates()).toBe(4);
  });
});
