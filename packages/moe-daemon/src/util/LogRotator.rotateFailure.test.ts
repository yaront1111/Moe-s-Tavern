// A failed or timed-out compression must not consume the rotated generations:
// LogRotator compresses the live log to a temporary file first and changes the
// chain only after that file is complete.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { Transform } from 'stream';
import { LogRotator, ROTATION_RETRY_DELAY_MS } from './LogRotator.js';
import { logger } from './logger.js';

const GENERATIONS = [1, 2, 3, 4, 5];
const LIVE_CONTENT = 'live-line\n'.repeat(30); // ~300 bytes, over the ~105 byte threshold

describe('LogRotator failed rotation keeps the chain and the live log', () => {
  const tempDirs: string[] = [];
  let now = 0;

  beforeEach(() => {
    // A fake clock, not vi.useFakeTimers: compressFile's real streams and
    // its timeout depend on the real timers.
    now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function advancePastRetryDelay(): void {
    now += ROTATION_RETRY_DELAY_MS + 1;
  }

  /** activity.log.1-5.gz holding gen-1..gen-5 and a live log over the threshold. */
  function seed(): { dir: string; logPath: string; rotator: LogRotator; listing: string[] } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-log-rotate-failure-'));
    tempDirs.push(dir);
    const logPath = path.join(dir, 'activity.log');
    for (const n of GENERATIONS) {
      fs.writeFileSync(`${logPath}.${n}.gz`, zlib.gzipSync(`gen-${n}\n`));
    }
    fs.writeFileSync(logPath, LIVE_CONTENT);
    const rotator = new LogRotator(logPath, { maxSizeMB: 0.0001, retentionCount: 5 });
    return { dir, logPath, rotator, listing: fs.readdirSync(dir).sort() };
  }

  function readGeneration(logPath: string, n: number): string {
    return zlib.gunzipSync(fs.readFileSync(`${logPath}.${n}.gz`)).toString('utf-8');
  }

  /** Every seeded generation in place with its seeded text, the live log and listing untouched. */
  function expectSeededState(dir: string, logPath: string, listing: string[]): void {
    for (const n of GENERATIONS) {
      expect(readGeneration(logPath, n)).toBe(`gen-${n}\n`);
    }
    expect(fs.readFileSync(logPath).equals(Buffer.from(LIVE_CONTENT))).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(listing);
  }

  // A gzip stream that fails on its first chunk, the way a full disk (ENOSPC)
  // or a locked destination fails the real one.
  function failingGzip(): zlib.Gzip {
    return new Transform({
      transform(_chunk, _enc, cb) {
        cb(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
      },
    }) as unknown as zlib.Gzip;
  }

  it('(f1) one failing rotation keeps .1-.5.gz, the live log and the directory listing', async () => {
    const { dir, logPath, rotator, listing } = seed();
    vi.spyOn(zlib, 'createGzip').mockImplementation(failingGzip);

    expect(await rotator.rotateIfNeeded()).toBe(false); // swallowed, as appendActivity expects

    expectSeededState(dir, logPath, listing);
  });

  it('(f2) five failing rotations keep everything; a later success shifts the chain and truncates the live log', async () => {
    const { dir, logPath, rotator, listing } = seed();
    const gzipSpy = vi.spyOn(zlib, 'createGzip').mockImplementation(failingGzip);

    for (let attempt = 0; attempt < 5; attempt++) {
      advancePastRetryDelay();
      expect(await rotator.rotateIfNeeded()).toBe(false);
      expectSeededState(dir, logPath, listing);
    }
    expect(gzipSpy).toHaveBeenCalledTimes(5); // each attempt really compressed

    gzipSpy.mockRestore();
    advancePastRetryDelay();
    expect(await rotator.rotateIfNeeded()).toBe(true);

    expect(readGeneration(logPath, 1)).toBe(LIVE_CONTENT);
    for (const n of [1, 2, 3, 4]) {
      expect(readGeneration(logPath, n + 1)).toBe(`gen-${n}\n`); // the oldest, gen-5, is dropped
    }
    expect(fs.statSync(logPath).size).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual(listing); // activity.log plus .1-.5.gz, no temp file
  });

  it('(f3) after a failure no further rotation is attempted until the retry delay has passed', async () => {
    const { dir, logPath, rotator, listing } = seed();
    const gzipSpy = vi.spyOn(zlib, 'createGzip').mockImplementation(failingGzip);

    expect(await rotator.rotateIfNeeded()).toBe(false);
    expect(gzipSpy).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);

    now += ROTATION_RETRY_DELAY_MS - 1; // still inside the delay
    expect(await rotator.rotateIfNeeded()).toBe(false);
    expect(gzipSpy).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);

    now += 2; // the delay has passed
    expect(await rotator.rotateIfNeeded()).toBe(false);
    expect(gzipSpy).toHaveBeenCalledTimes(2);

    expectSeededState(dir, logPath, listing);
  });

  it('(f5) a failed rotation removes the temporary file even when the destination opens after the gzip error', async () => {
    const { dir, logPath, rotator, listing } = seed();
    // The order a busy libuv threadpool produces: the write stream's open
    // completes only after the gzip error has been handled.
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const realCreateWriteStream = fs.createWriteStream;
    const destinations: fs.WriteStream[] = [];
    vi.spyOn(fs, 'createWriteStream').mockImplementation(((file: fs.PathLike) => {
      const gatedFs = {
        open: (p: fs.PathLike, flags: fs.OpenMode, mode: fs.Mode, cb: (err: NodeJS.ErrnoException | null, fd: number) => void) => {
          void openGate.then(() => fs.open(p, flags, mode, cb));
        },
        write: fs.write,
        writev: fs.writev,
        close: fs.close,
      };
      const stream = realCreateWriteStream(file, { fs: gatedFs } as unknown as Parameters<typeof fs.createWriteStream>[1]);
      destinations.push(stream);
      return stream;
    }) as typeof fs.createWriteStream);
    vi.spyOn(zlib, 'createGzip').mockImplementation(() => {
      const gzip = failingGzip();
      gzip.once('error', () => setImmediate(releaseOpen));
      return gzip;
    });

    expect(await rotator.rotateIfNeeded()).toBe(false);

    expect(destinations).toHaveLength(1);
    const [destination] = destinations;
    if (!destination.closed) {
      await new Promise((resolve) => destination.once('close', resolve)); // the late open has landed and closed
    }
    expect(fs.existsSync(`${logPath}.rotating.tmp`)).toBe(false);
    expectSeededState(dir, logPath, listing);
  });

  it('(f4) a compression that rejects after a partial write targets only a temporary file and removes it', async () => {
    const { dir, logPath, rotator, listing } = seed();
    const destinations: string[] = [];
    // The timeout path of compressFile: it destroys its streams but never removes its destination.
    vi.spyOn(rotator as unknown as { compressFile(src: string, dest: string): Promise<void> }, 'compressFile')
      .mockImplementation(async (_src: string, dest: string) => {
        destinations.push(dest);
        fs.writeFileSync(dest, 'partial');
        throw new Error('Compression timed out after 30000ms');
      });

    expect(await rotator.rotateIfNeeded()).toBe(false);

    expect(destinations).toHaveLength(1);
    const [dest] = destinations;
    expect(path.dirname(dest)).toBe(dir);
    expect(path.basename(dest)).not.toMatch(/^activity\.log\.\d+\.gz$/);
    expect(fs.existsSync(dest)).toBe(false);
    expectSeededState(dir, logPath, listing);
  });
});
