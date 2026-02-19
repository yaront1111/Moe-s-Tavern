import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { PassThrough } from 'stream';
import { LogRotator } from './LogRotator.js';

describe('LogRotator compressFile', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-log-rotator-'));
    tempDirs.push(dir);
    return dir;
  }

  it('compressFile completes successfully for a valid file', async () => {
    const dir = createTempDir();
    const sourcePath = path.join(dir, 'activity.log');
    const destPath = path.join(dir, 'activity.log.1.gz');
    const content = 'line-1\nline-2\nline-3\n';
    fs.writeFileSync(sourcePath, content, 'utf-8');

    const rotator = new LogRotator(sourcePath);
    await (rotator as any).compressFile(sourcePath, destPath);

    const compressed = fs.readFileSync(destPath);
    const decompressed = zlib.gunzipSync(compressed).toString('utf-8');
    expect(decompressed).toBe(content);
  });

  it('compressFile handles source stream errors with cleanup/unpipe', async () => {
    const dir = createTempDir();
    const logPath = path.join(dir, 'activity.log');
    const rotator = new LogRotator(logPath);

    const source = new PassThrough();
    const gzip = new PassThrough();
    const destination = new PassThrough();

    const sourceUnpipeSpy = vi.spyOn(source, 'unpipe');
    const gzipUnpipeSpy = vi.spyOn(gzip, 'unpipe');
    const destinationDestroySpy = vi.spyOn(destination, 'destroy');
    const warningSpy = vi.spyOn(process, 'emitWarning');

    vi.spyOn(fs, 'createReadStream').mockReturnValue(source as unknown as fs.ReadStream);
    vi.spyOn(fs, 'createWriteStream').mockReturnValue(destination as unknown as fs.WriteStream);
    vi.spyOn(zlib, 'createGzip').mockReturnValue(gzip as unknown as zlib.Gzip);

    const compression = (rotator as any).compressFile('source.log', 'dest.gz');
    source.emit('error', new Error('read failure'));

    await expect(compression).rejects.toThrow('read failure');
    expect(sourceUnpipeSpy).toHaveBeenCalled();
    expect(gzipUnpipeSpy).toHaveBeenCalled();
    expect(destinationDestroySpy).toHaveBeenCalled();
    const warningMessages = warningSpy.mock.calls.map((call) => String(call[0]).toLowerCase());
    expect(warningMessages.some((message) => message.includes('write after destroy'))).toBe(false);
  });

  it('compressFile times out and cleans up stalled streams', async () => {
    const dir = createTempDir();
    const logPath = path.join(dir, 'activity.log');
    const rotator = new LogRotator(logPath);

    const source = new PassThrough();
    const gzip = new PassThrough();
    const destination = new PassThrough();

    const sourceDestroySpy = vi.spyOn(source, 'destroy');
    const gzipDestroySpy = vi.spyOn(gzip, 'destroy');
    const destinationDestroySpy = vi.spyOn(destination, 'destroy');
    const warningSpy = vi.spyOn(process, 'emitWarning');

    vi.spyOn(fs, 'createReadStream').mockReturnValue(source as unknown as fs.ReadStream);
    vi.spyOn(fs, 'createWriteStream').mockReturnValue(destination as unknown as fs.WriteStream);
    vi.spyOn(zlib, 'createGzip').mockReturnValue(gzip as unknown as zlib.Gzip);

    vi.useFakeTimers();
    const compression = (rotator as any).compressFile('source.log', 'dest.gz');
    const rejectionAssertion = expect(compression).rejects.toThrow('Compression timed out after 30000ms');
    await vi.advanceTimersByTimeAsync(30_000);

    await rejectionAssertion;
    expect(sourceDestroySpy).toHaveBeenCalled();
    expect(gzipDestroySpy).toHaveBeenCalled();
    expect(destinationDestroySpy).toHaveBeenCalled();
    const warningMessages = warningSpy.mock.calls.map((call) => String(call[0]).toLowerCase());
    expect(warningMessages.some((message) => message.includes('write after destroy'))).toBe(false);
  });
});
