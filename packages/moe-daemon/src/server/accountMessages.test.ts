import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { applyAccountMessage } from './accountMessages.js';
import { readRegistry } from '../accounts/registry.js';

// The IDE's Accounts tab edits the machine's account list through these
// messages; every edit broadcasts the new list.

const VITEST_ACCOUNTS_FILE = process.env.MOE_ACCOUNTS_FILE;

let testDir: string;
let accountsFile: string;
let state: StateManager;

beforeEach(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-account-messages-'));
  accountsFile = path.join(testDir, 'machine', 'claude-accounts.json');
  process.env.MOE_ACCOUNTS_FILE = accountsFile;
  const moePath = path.join(testDir, 'project', '.moe');
  for (const sub of ['epics', 'tasks', 'workers', 'proposals']) fs.mkdirSync(path.join(moePath, sub), { recursive: true });
  fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify({
    id: 'proj-test', schemaVersion: 6, name: 'Test', rootPath: path.join(testDir, 'project'),
    globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
    settings: { approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false, branchPattern: '', commitPattern: '', agentCommand: 'claude' },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  state = new StateManager({ projectPath: path.join(testDir, 'project') });
  await state.load();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (VITEST_ACCOUNTS_FILE === undefined) delete process.env.MOE_ACCOUNTS_FILE;
  else process.env.MOE_ACCOUNTS_FILE = VITEST_ACCOUNTS_FILE;
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('applyAccountMessage', () => {
  it('adds, renames, moves and removes accounts, broadcasting each change', () => {
    const emit = vi.spyOn(state, 'emit');
    expect(applyAccountMessage(state, 'ADD_ACCOUNT', { label: 'Work' })).toEqual({ type: 'ACCOUNT_ADDED', payload: { accountId: 'acct-1' } });
    expect(applyAccountMessage(state, 'ADD_ACCOUNT', undefined)).toEqual({ type: 'ACCOUNT_ADDED', payload: { accountId: 'acct-2' } });
    expect(applyAccountMessage(state, 'RENAME_ACCOUNT', { accountId: 'acct-2', label: 'Home' })).toBeNull();
    applyAccountMessage(state, 'MOVE_ACCOUNT', { accountId: 'acct-2', offset: -1 });
    applyAccountMessage(state, 'SET_ACCOUNT_SWITCH_PERCENT', { switchAtPercent: 85 });
    expect(readRegistry(accountsFile)).toMatchObject({
      switchAtPercent: 85,
      accounts: [{ id: 'acct-2', label: 'Home' }, { id: 'acct-1', label: 'Work' }],
    });
    applyAccountMessage(state, 'REMOVE_ACCOUNT', { accountId: 'acct-1' });
    expect(readRegistry(accountsFile)!.accounts.map((account) => account.id)).toEqual(['acct-2']);

    const broadcasts = emit.mock.calls.map(([event]) => event).filter((event) => event.type === 'ACCOUNTS_UPDATED');
    expect(broadcasts).toHaveLength(6);
    expect(broadcasts.at(-1)?.payload).toMatchObject({ switchAtPercent: 85, accounts: [{ id: 'acct-2', label: 'Home', signIn: 'signed_out' }] });
  });

  it('refuses bad input without touching the list', () => {
    applyAccountMessage(state, 'ADD_ACCOUNT', {});
    const before = fs.readFileSync(accountsFile, 'utf8');
    expect(() => applyAccountMessage(state, 'REMOVE_ACCOUNT', {})).toThrow(/accountId/);
    expect(() => applyAccountMessage(state, 'MOVE_ACCOUNT', { accountId: 'acct-1', offset: 2 })).toThrow(/offset/);
    expect(() => applyAccountMessage(state, 'SET_ACCOUNT_SWITCH_PERCENT', { switchAtPercent: 0 })).toThrow(/switchAtPercent/);
    expect(() => applyAccountMessage(state, 'SET_ACCOUNT_SWITCH_PERCENT', { switchAtPercent: 90.5 })).toThrow(/switchAtPercent/);
    expect(() => applyAccountMessage(state, 'RENAME_ACCOUNT', { accountId: 'acct-1', label: 'x'.repeat(65) })).toThrow('MOE_ACCOUNT_LABEL_INVALID');
    expect(() => applyAccountMessage(state, 'REMOVE_ACCOUNT', { accountId: 'acct-7' })).toThrow('MOE_ACCOUNT_UNKNOWN');
    expect(fs.readFileSync(accountsFile, 'utf8')).toBe(before);
  });
});
