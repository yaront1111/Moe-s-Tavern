import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
  setSwitchAtPercent,
  writeJsonAtomic,
} from './registry.js';

// The machine's Claude account list. It must never carry anything but ids,
// labels and sign-in states: unknown keys make the whole file invalid.

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-registry-'));
  file = path.join(dir, 'claude-accounts.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('paths', () => {
  it('uses MOE_ACCOUNTS_FILE, else ~/.moe/claude-accounts.json', () => {
    expect(registryFilePath({ MOE_ACCOUNTS_FILE: file })).toBe(path.resolve(file));
    expect(registryFilePath({})).toBe(path.join(os.homedir(), '.moe', 'claude-accounts.json'));
  });

  it('keeps each config directory and usage file next to the list', () => {
    expect(accountConfigDir(file, 'acct-1')).toBe(path.join(dir, 'claude-accounts', 'acct-1'));
    expect(accountUsageFile(file, 'acct-1')).toBe(path.join(dir, 'claude-usage', 'acct-1.json'));
  });
});

describe('addAccount', () => {
  it('creates the list and adds signed-out accounts acct-1, acct-2, …', () => {
    expect(readRegistry(file)).toBeNull();
    expect(addAccount(file, '  Work Max  ')).toEqual({ id: 'acct-1', label: 'Work Max', signIn: 'signed_out', signInCheckedAt: null });
    expect(addAccount(file).id).toBe('acct-2');
    expect(readRegistry(file)).toEqual({
      version: 1,
      switchAtPercent: 90,
      accounts: [
        { id: 'acct-1', label: 'Work Max', signIn: 'signed_out', signInCheckedAt: null },
        { id: 'acct-2', label: 'acct-2', signIn: 'signed_out', signInCheckedAt: null },
      ],
    });
  });

  it('skips an id whose config directory still exists, so a removed login is never inherited', () => {
    addAccount(file);
    addAccount(file);
    fs.mkdirSync(accountConfigDir(file, 'acct-1'), { recursive: true });
    removeAccount(file, 'acct-1');
    expect(addAccount(file).id).toBe('acct-3');
  });

  it('drops a leftover usage file for the new id', () => {
    writeJsonAtomic(accountUsageFile(file, 'acct-1'), { id: 'acct-1', windows: {}, refusedUntil: null, updatedAt: '2026-10-20T00:00:00.000Z' });
    addAccount(file);
    expect(fs.existsSync(accountUsageFile(file, 'acct-1'))).toBe(false);
  });

  it('refuses a bad label and a 33rd account', () => {
    expect(() => addAccount(file, 'x'.repeat(65))).toThrow('MOE_ACCOUNT_LABEL_INVALID');
    expect(() => addAccount(file, 'a\nb')).toThrow('MOE_ACCOUNT_LABEL_INVALID');
    for (let i = 0; i < 32; i++) addAccount(file);
    expect(() => addAccount(file)).toThrow('MOE_ACCOUNT_LIMIT');
  });
});

describe('edits', () => {
  it('moves, renames, records sign-ins and sets the switch percent', () => {
    addAccount(file, 'One');
    addAccount(file, 'Two');
    addAccount(file, 'Three');
    moveAccount(file, 'acct-3', -1);
    moveAccount(file, 'acct-1', -1); // already first: nothing to do
    renameAccount(file, 'acct-2', 'Second');
    setSwitchAtPercent(file, 80);
    const at = Date.parse('2026-10-20T10:00:00.000Z');
    expect(recordSignIn(file, 'acct-1', 'subscription', at)).toEqual({
      id: 'acct-1', label: 'One', signIn: 'subscription', signInCheckedAt: '2026-10-20T10:00:00.000Z',
    });
    expect(recordSignIn(file, 'acct-9', 'subscription', at)).toBeNull();
    const registry = readRegistry(file)!;
    expect(registry.switchAtPercent).toBe(80);
    expect(registry.accounts.map((a) => `${a.id}:${a.label}:${a.signIn}`)).toEqual([
      'acct-1:One:subscription',
      'acct-3:Three:signed_out',
      'acct-2:Second:signed_out',
    ]);
  });

  it('removes the usage file with the account but keeps its config directory', () => {
    addAccount(file);
    fs.mkdirSync(accountConfigDir(file, 'acct-1'), { recursive: true });
    writeJsonAtomic(accountUsageFile(file, 'acct-1'), { id: 'acct-1', windows: {}, refusedUntil: null, updatedAt: '2026-10-20T00:00:00.000Z' });
    removeAccount(file, 'acct-1');
    expect(readRegistry(file)!.accounts).toEqual([]);
    expect(fs.existsSync(accountUsageFile(file, 'acct-1'))).toBe(false);
    expect(fs.existsSync(accountConfigDir(file, 'acct-1'))).toBe(true);
  });

  it('names an unknown account', () => {
    expect(() => removeAccount(file, 'acct-1')).toThrow('MOE_ACCOUNT_UNKNOWN');
    addAccount(file);
    expect(() => renameAccount(file, 'acct-9', 'x')).toThrow('MOE_ACCOUNT_UNKNOWN');
    expect(() => moveAccount(file, 'acct-9', 1)).toThrow('MOE_ACCOUNT_UNKNOWN');
  });
});

describe('readRegistry', () => {
  const write = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value));

  it('refuses unknown keys, bad ids, duplicates and bad numbers, so nothing rides along', () => {
    write({ version: 1, accounts: [{ id: 'acct-1', dir: '/home/me/.claude' }] });
    expect(() => readRegistry(file)).toThrow(/MOE_ACCOUNT_REGISTRY_INVALID.*unknown key "dir"/);
    write({ version: 1, token: 'x', accounts: [] });
    expect(() => readRegistry(file)).toThrow('unknown key "token"');
    write({ version: 1, accounts: [{ id: '../x' }] });
    expect(() => readRegistry(file)).toThrow('accounts[0].id');
    write({ version: 1, accounts: [{ id: 'a' }, { id: 'a' }] });
    expect(() => readRegistry(file)).toThrow('duplicate');
    write({ version: 1, switchAtPercent: 0, accounts: [] });
    expect(() => readRegistry(file)).toThrow('switchAtPercent');
    write({ version: 1, accounts: [{ id: 'a', signIn: 'maybe' }] });
    expect(() => readRegistry(file)).toThrow('signIn');
    write({ version: 2, accounts: [] });
    expect(() => readRegistry(file)).toThrow('version');
    fs.writeFileSync(file, '{');
    expect(() => readRegistry(file)).toThrow('not valid JSON');
  });

  it('fills the defaults of a hand-written list', () => {
    write({ version: 1, accounts: [{ id: 'mine' }] });
    expect(readRegistry(file)).toEqual({
      version: 1,
      switchAtPercent: 90,
      accounts: [{ id: 'mine', label: 'mine', signIn: 'signed_out', signInCheckedAt: null }],
    });
  });
});
