import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from './StateManager.js';
import { accountRotationView, accountSwitchFor, leaseAccount, recordAccountReport } from './accountStore.js';
import { accountUsageFile, addAccount, recordSignIn, writeJsonAtomic } from '../accounts/registry.js';
import { parseUsageWindows } from '../accounts/usageWindows.js';
import type { Project, Worker } from '../types/schema.js';

// A read error of the account list or of a usage file is not a fact about the
// file's contents: it clears without changing the file's inode, mtime or size,
// the key accountStore caches under. So an I/O failure is reported for the call
// that hit it and never cached, while a content error (bad JSON, failed
// validation) is still read once and cached.

/** Set by vitest.config.ts before any test file loads. */
const VITEST_ACCOUNTS_FILE = process.env.MOE_ACCOUNTS_FILE;

const T0 = Date.parse('2026-10-20T12:00:00.000Z');
const HOUR = 3_600_000;
const realReadFileSync = fs.readFileSync;
const cannotChmod = process.platform === 'win32' || process.getuid?.() === 0;

let testDir: string;
let accountsFile: string;
let state: StateManager;
/** Resolved path -> errno code its next reads fail with. */
let faults: Map<string, string>;
/** Resolved path -> readFileSync calls so far. */
let reads: Map<string, number>;

function writeWorker(projectDir: string, id: string): void {
  const now = new Date().toISOString();
  const worker: Worker = {
    id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1', currentTaskId: null, status: 'IDLE',
    teamId: null, branch: 'main', modifiedFiles: [], startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0,
  };
  fs.writeFileSync(path.join(projectDir, '.moe', 'workers', `${id}.json`), JSON.stringify(worker, null, 2));
}

async function newState(projectDir: string, workerIds: string[]): Promise<StateManager> {
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
  vi.spyOn(loaded, 'postToRoleChannel').mockResolvedValue();
  vi.spyOn(loaded, 'appendActivity').mockImplementation((() => undefined) as unknown as StateManager['appendActivity']);
  return loaded;
}

/** Fail readFileSync with an errno error for the faulted paths; count every string-path read; pass the rest through. */
function installReadSpy(): void {
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof file === 'string') {
      const key = path.resolve(file);
      reads.set(key, (reads.get(key) ?? 0) + 1);
      const code = faults.get(key);
      if (code) throw Object.assign(new Error(`${code}: injected, open '${file}'`), { code });
    }
    return Reflect.apply(realReadFileSync, fs, [file, ...rest]);
  }) as typeof fs.readFileSync);
}

function failReads(file: string, code: string): void {
  faults.set(path.resolve(file), code);
}

function restoreReads(file: string): void {
  faults.delete(path.resolve(file));
}

function readsOf(file: string): number {
  return reads.get(path.resolve(file)) ?? 0;
}

function signedIn(count: number): void {
  for (let n = 1; n <= count; n++) {
    addAccount(accountsFile, `Acct ${n}`);
    recordSignIn(accountsFile, `acct-${n}`, 'subscription', T0);
  }
}

/** What another daemon's report leaves behind: five_hour at `percent`, resetting in two hours. */
function putUsage(id: string, percent: number, refusedUntil: string | null = null): string {
  const usageFile = accountUsageFile(accountsFile, id);
  writeJsonAtomic(usageFile, {
    id,
    refusedUntil,
    updatedAt: new Date(T0).toISOString(),
    windows: {
      five_hour: {
        percent,
        resetsAt: new Date(T0 + 2 * HOUR).toISOString(),
        status: 'allowed',
        sampledAt: new Date(T0).toISOString(),
      },
    },
  });
  return usageFile;
}

function acctView(id: string) {
  const account = accountRotationView(state, T0).accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`no ${id} in the view`);
  return account;
}

function writeRawList(text: string): void {
  fs.mkdirSync(path.dirname(accountsFile), { recursive: true });
  fs.writeFileSync(accountsFile, text);
}

beforeEach(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-account-read-retry-'));
  accountsFile = path.join(testDir, 'machine', 'claude-accounts.json');
  process.env.MOE_ACCOUNTS_FILE = accountsFile;
  faults = new Map();
  reads = new Map();
  state = await newState(path.join(testDir, 'project'), ['w1', 'w2', 'w3']);
  installReadSpy();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (VITEST_ACCOUNTS_FILE === undefined) delete process.env.MOE_ACCOUNTS_FILE;
  else process.env.MOE_ACCOUNTS_FILE = VITEST_ACCOUNTS_FILE;
  for (const file of [accountsFile, accountUsageFile(accountsFile, 'acct-1')]) {
    try { fs.chmodSync(file, 0o600); } catch { /* not there */ }
  }
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('the account list: an I/O read error is reported, never cached', () => {
  it.each(['EACCES', 'EBUSY', 'EMFILE'])('%s: rotation resumes once the list reads again, with no write in between', async (code) => {
    signedIn(2);
    failReads(accountsFile, code);

    const during = await leaseAccount(state, 'w1', T0);
    expect(during.rotation).toBe(false);
    const reason = during.rotation === false ? during.reason : null;
    expect(reason).toContain('the Claude account list cannot be used (MOE_ACCOUNT_REGISTRY_INVALID');
    expect(reason).toContain(`cannot read it (${code}`);
    expect(accountRotationView(state, T0).error).toContain(`cannot read it (${code}`);

    const readsWhileFailing = readsOf(accountsFile);
    await leaseAccount(state, 'w1', T0);
    expect(readsOf(accountsFile)).toBeGreaterThan(readsWhileFailing); // read again, not served from a cached failure

    restoreReads(accountsFile);
    expect(await leaseAccount(state, 'w1', T0)).toMatchObject({ rotation: true, accountId: 'acct-1' });
    expect(accountRotationView(state, T0).error).toBeNull();
  });

  it.skipIf(cannotChmod)('chmod 000, lease, chmod 600, lease: the next lease rotates', async () => {
    signedIn(2);
    fs.chmodSync(accountsFile, 0o000);
    const during = await leaseAccount(state, 'w1', T0);
    expect(during.rotation === false && during.reason).toContain('cannot read it (EACCES');

    fs.chmodSync(accountsFile, 0o600); // inode, mtime and size are unchanged
    expect(await leaseAccount(state, 'w1', T0)).toMatchObject({ rotation: true, accountId: 'acct-1' });
    expect(accountRotationView(state, T0).error).toBeNull();
  });

  it('ENOENT still means no list: rotation is off with no reason', async () => {
    signedIn(1);
    failReads(accountsFile, 'ENOENT');
    expect(await leaseAccount(state, 'w1', T0)).toEqual({ rotation: false, reason: null });
    expect(accountRotationView(state, T0).error).toBeNull();
  });

  it('a report is dropped while the list cannot be read, and recorded once it can', async () => {
    signedIn(1);
    failReads(accountsFile, 'EBUSY');
    const windows = parseUsageWindows({ five_hour: { percent: 50, resetsAt: Math.floor((T0 + 2 * HOUR) / 1000) } }, T0);
    const dropped = await recordAccountReport(state, { workerId: 'w1', accountId: 'acct-1', windows, refused: false }, T0);
    expect(dropped).toEqual({ recorded: false, blockedUntil: null, peakPercent: null });

    restoreReads(accountsFile);
    const kept = await recordAccountReport(state, { workerId: 'w1', accountId: 'acct-1', windows, refused: false }, T0);
    expect(kept).toMatchObject({ recorded: true, peakPercent: 50 });
  });
});

describe('the account list: a content error is reported and still cached', () => {
  it.each([
    ['invalid JSON', '{ not json', 'not valid JSON'],
    ['a failed validation', JSON.stringify({ version: 1, switchAtPercent: 150, accounts: [] }), 'switchAtPercent must be a whole number from 1 to 100'],
  ])('%s: MOE_ACCOUNT_REGISTRY_INVALID, with the file read once across two leases', async (_name, text, detail) => {
    writeRawList(text);
    for (const workerId of ['w1', 'w2']) {
      const lease = await leaseAccount(state, workerId, T0);
      expect(lease.rotation).toBe(false);
      expect(lease.rotation === false && lease.reason).toContain('the Claude account list cannot be used (MOE_ACCOUNT_REGISTRY_INVALID');
      expect(lease.rotation === false && lease.reason).toContain(detail);
    }
    expect(accountRotationView(state, T0).error).toContain(detail);
    expect(readsOf(accountsFile)).toBe(1);
  });
});

describe('a usage file: an I/O read error keeps the last good sample and is never cached', () => {
  it('a spent account stays spent while its file cannot be read, and the new contents are read afterwards', async () => {
    signedIn(1);
    expect(await leaseAccount(state, 'w1', T0)).toMatchObject({ rotation: true, accountId: 'acct-1' });
    const usageFile = putUsage('acct-1', 95);
    expect(await leaseAccount(state, 'w2', T0)).toMatchObject({ rotation: true, accountId: null });
    expect(acctView('acct-1').peakPercent).toBe(95);

    putUsage('acct-1', 5); // another daemon on the machine rewrote it (a new inode), and our read of it fails
    failReads(usageFile, 'EIO');
    expect(await leaseAccount(state, 'w3', T0)).toMatchObject({ rotation: true, accountId: null });
    expect(acctView('acct-1')).toMatchObject({ peakPercent: 95, active: false });
    expect(acctView('acct-1').blockedUntil).toBe(new Date(T0 + 2 * HOUR).toISOString());

    const readsWhileFailing = readsOf(usageFile);
    await leaseAccount(state, 'w3', T0);
    expect(readsOf(usageFile)).toBeGreaterThan(readsWhileFailing);

    restoreReads(usageFile);
    expect(await leaseAccount(state, 'w3', T0)).toMatchObject({ rotation: true, accountId: 'acct-1', peakPercent: 5 });
    expect(acctView('acct-1')).toMatchObject({ peakPercent: 5, blockedUntil: null });
  });

  it('a seat on a spent account is still told to switch while the file cannot be read', async () => {
    signedIn(2);
    expect(await leaseAccount(state, 'w1', T0)).toMatchObject({ accountId: 'acct-1' });
    const usageFile = putUsage('acct-1', 95);
    expect(await leaseAccount(state, 'w2', T0)).toMatchObject({ accountId: 'acct-2' });
    expect(accountSwitchFor(state, 'w1', T0)).toMatchObject({ from: 'acct-1', to: 'acct-2', fromPeakPercent: 95 });

    putUsage('acct-1', 5);
    failReads(usageFile, 'EACCES');
    expect(accountSwitchFor(state, 'w1', T0)).toMatchObject({ from: 'acct-1', to: 'acct-2', fromPeakPercent: 95 });

    restoreReads(usageFile);
    expect(accountSwitchFor(state, 'w1', T0)).toBeNull(); // 5% is back under the switch percent
  });

  it('with no good sample yet it fails open as before, and reads the file again on the next call', async () => {
    signedIn(2);
    expect(await leaseAccount(state, 'w1', T0)).toMatchObject({ accountId: 'acct-1' }); // no usage file: nothing to be spent on
    const usageFile = putUsage('acct-1', 95);
    failReads(usageFile, 'EACCES');
    expect(await leaseAccount(state, 'w2', T0)).toMatchObject({ accountId: 'acct-1' });

    restoreReads(usageFile);
    expect(await leaseAccount(state, 'w3', T0)).toMatchObject({ accountId: 'acct-2' });
    expect(acctView('acct-1').peakPercent).toBe(95);
  });
});

describe('recordAccountReport never builds the stored usage from an empty base', () => {
  const windows = () => parseUsageWindows({ five_hour: { percent: 60, resetsAt: Math.floor((T0 + 2 * HOUR) / 1000) } }, T0);

  it('leaves the usage file\'s bytes unchanged while it cannot be read, and merges once it can', async () => {
    signedIn(2);
    const refusedUntil = new Date(T0 + HOUR).toISOString();
    const usageFile = putUsage('acct-1', 40, refusedUntil);
    expect(acctView('acct-1')).toMatchObject({ peakPercent: 40 }); // the last good sample, cached
    const before = fs.readFileSync(usageFile, 'utf8');

    failReads(usageFile, 'EBUSY');
    const during = await recordAccountReport(state, { workerId: 'w1', accountId: 'acct-1', windows: windows(), refused: false }, T0);
    restoreReads(usageFile);
    expect(fs.readFileSync(usageFile, 'utf8')).toBe(before); // no overwrite: the 40% window and the refusal survive
    expect(during).toEqual({ recorded: false, blockedUntil: refusedUntil, peakPercent: 40 });

    const after = await recordAccountReport(state, { workerId: 'w1', accountId: 'acct-1', windows: windows(), refused: false }, T0);
    expect(after).toMatchObject({ recorded: true, blockedUntil: refusedUntil, peakPercent: 60 });
    const stored = JSON.parse(fs.readFileSync(usageFile, 'utf8')) as { refusedUntil: string; windows: { five_hour: { percent: number } } };
    expect(stored.windows.five_hour.percent).toBe(60);
    expect(stored.refusedUntil).toBe(refusedUntil);
  });

  it('replies with nulls when the unreadable file has no good sample, and still records a sign-in change', async () => {
    signedIn(1);
    const usageFile = putUsage('acct-1', 40);
    failReads(usageFile, 'EMFILE');
    const result = await recordAccountReport(state, { workerId: 'w1', accountId: 'acct-1', windows: windows(), refused: false, signIn: 'signed_out' }, T0);
    expect(result).toEqual({ recorded: true, blockedUntil: null, peakPercent: null }); // the sign-in was recorded; no usage to report
    restoreReads(usageFile);
    expect(JSON.parse(fs.readFileSync(usageFile, 'utf8')).windows.five_hour.percent).toBe(40);
  });
});
