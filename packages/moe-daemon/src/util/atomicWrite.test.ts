import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWriteText } from './atomicWrite.js';

describe('atomicWriteText — synchronous rename backoff (L3)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-atomicwrite-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('writes successfully on the happy path', () => {
    const target = path.join(testDir, 'out.json');
    atomicWriteText(target, 'hello');
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello');
  });

  it('backs off between retries instead of burning all attempts instantly', () => {
    const target = path.join(testDir, 'retry.json');
    const realRename = fs.renameSync.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      calls += 1;
      // Fail the first two attempts with a retryable Windows-style lock error,
      // then let the real rename through.
      if (calls <= 2) {
        const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realRename(from as string, to as string);
    }) as typeof fs.renameSync);

    const start = Date.now();
    atomicWriteText(target, 'world');
    const elapsed = Date.now() - start;

    spy.mockRestore();

    expect(calls).toBe(3);
    expect(fs.readFileSync(target, 'utf-8')).toBe('world');
    // Two failures → ~10ms + ~20ms of backoff. Assert a conservative lower
    // bound that the zero-backoff implementation could never satisfy.
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });

  it('still throws after exhausting retries (cleaning up the temp file)', () => {
    const target = path.join(testDir, 'always-fail.json');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((() => {
      const err = new Error('EBUSY: resource busy or locked, rename') as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    }) as typeof fs.renameSync);

    expect(() => atomicWriteText(target, 'nope')).toThrowError(/EBUSY/);
    // 5 attempts, all failing.
    expect(spy).toHaveBeenCalledTimes(5);
    spy.mockRestore();

    // Temp file must be cleaned up, target must not exist.
    expect(fs.existsSync(target)).toBe(false);
    const leftovers = fs.readdirSync(testDir).filter((f) => f.includes('always-fail.json'));
    expect(leftovers).toEqual([]);
  });
});
