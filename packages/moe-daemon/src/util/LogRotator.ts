// =============================================================================
// LogRotator - Activity log rotation with compression
// =============================================================================

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { logger } from './logger.js';

// Configuration from environment variables with defaults
const DEFAULT_MAX_SIZE_MB = 10;
const DEFAULT_RETENTION_COUNT = 5;
const DEFAULT_COMPRESSION_TIMEOUT_MS = 30_000;
const COMPRESSION_TIMEOUT_MS_ENV = parseInt(
  process.env.LOG_COMPRESSION_TIMEOUT_MS || `${DEFAULT_COMPRESSION_TIMEOUT_MS}`,
  10
);
const COMPRESSION_TIMEOUT_MS =
  Number.isFinite(COMPRESSION_TIMEOUT_MS_ENV) && COMPRESSION_TIMEOUT_MS_ENV > 0
    ? COMPRESSION_TIMEOUT_MS_ENV
    : DEFAULT_COMPRESSION_TIMEOUT_MS;

/** After a failed rotation, rotateIfNeeded skips further attempts for this long. */
export const ROTATION_RETRY_DELAY_MS = 60_000;

/** How long a failed compression waits for its destination to close before rejecting anyway. */
export const DESTINATION_CLOSE_WAIT_MS = 5_000;

export interface LogRotatorOptions {
  maxSizeMB?: number;
  retentionCount?: number;
}

export class LogRotator {
  private readonly logPath: string;
  private readonly maxSizeBytes: number;
  private readonly retentionCount: number;
  /** Epoch ms before which rotateIfNeeded does not attempt a rotation (set by a failure). */
  private retryAfter = 0;

  constructor(logPath: string, options?: LogRotatorOptions) {
    this.logPath = logPath;

    // Read from env vars or use provided options or defaults. Reject NaN,
    // Infinity, negative, and zero values; fall back to the default instead.
    const parsePositive = (raw: string | undefined, fallback: number): number => {
      if (!raw) return fallback;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };

    const maxSizeMB = options?.maxSizeMB && options.maxSizeMB > 0
      ? options.maxSizeMB
      : parsePositive(process.env.LOG_MAX_SIZE_MB, DEFAULT_MAX_SIZE_MB);
    this.maxSizeBytes = maxSizeMB * 1024 * 1024;

    this.retentionCount = options?.retentionCount && options.retentionCount > 0
      ? options.retentionCount
      : parsePositive(process.env.LOG_RETENTION_COUNT, DEFAULT_RETENTION_COUNT);
  }

  /**
   * Check if rotation is needed and perform it if so.
   * Should be called before appending to the log.
   */
  async rotateIfNeeded(): Promise<boolean> {
    // After a failed rotation, wait before trying again: every append calls
    // this under the activity mutex, so a persistent failure would otherwise
    // re-read and re-gzip the whole live log once per event.
    if (Date.now() < this.retryAfter) {
      return false;
    }

    if (!fs.existsSync(this.logPath)) {
      return false;
    }

    try {
      const stats = fs.statSync(this.logPath);
      if (stats.size < this.maxSizeBytes) {
        return false;
      }

      await this.rotate();
      return true;
    } catch (error) {
      this.retryAfter = Date.now() + ROTATION_RETRY_DELAY_MS;
      logger.error(
        { error, logPath: this.logPath, retryInMs: ROTATION_RETRY_DELAY_MS },
        'Failed to check/rotate log'
      );
      return false;
    }
  }

  /**
   * Perform log rotation. The generation chain changes only after a complete
   * compressed copy of the live log exists, so a failed or timed-out
   * compression (a full disk, a locked file) leaves every generation and the
   * live log exactly as they were:
   * 1. Remove a leftover temporary file from a crashed attempt
   * 2. Compress the live log into activity.log.rotating.tmp
   * 3. Shift existing rotated logs (activity.log.2.gz -> activity.log.3.gz);
   *    each rename replaces its target, so the first one drops the oldest
   * 4. Rename the temporary file to activity.log.1.gz
   * 5. Truncate the live log
   * Any failure removes the temporary file and rethrows the original error.
   */
  private async rotate(): Promise<void> {
    logger.info({ logPath: this.logPath, maxSizeMB: this.maxSizeBytes / 1024 / 1024 }, 'Rotating activity log');

    const dir = path.dirname(this.logPath);
    const baseName = path.basename(this.logPath);
    const pendingPath = path.join(dir, `${baseName}.rotating.tmp`);
    const compressedPath = path.join(dir, `${baseName}.1.gz`);

    try {
      fs.rmSync(pendingPath, { force: true });
      await this.compressFile(this.logPath, pendingPath);

      for (let i = this.retentionCount - 1; i >= 1; i--) {
        const oldPath = path.join(dir, `${baseName}.${i}.gz`);
        const newPath = path.join(dir, `${baseName}.${i + 1}.gz`);
        if (fs.existsSync(oldPath)) {
          fs.renameSync(oldPath, newPath);
        }
      }

      fs.renameSync(pendingPath, compressedPath);
      fs.writeFileSync(this.logPath, '');
    } catch (error) {
      try {
        fs.rmSync(pendingPath, { force: true });
      } catch (cleanupError) {
        logger.warn({ error: cleanupError, pendingPath }, 'Failed to remove temporary rotation file');
      }
      throw error;
    }

    logger.info({ rotatedTo: compressedPath }, 'Activity log rotated successfully');
  }

  /**
   * Compress a file using gzip.
   */
  private compressFile(sourcePath: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const source = fs.createReadStream(sourcePath);
      const destination = fs.createWriteStream(destPath);
      const gzip = zlib.createGzip();
      let settled = false;

      const unpipeStreams = (): void => {
        source.unpipe(gzip);
        gzip.unpipe(destination);
      };

      const resolveOnce = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve();
      };

      const rejectOnce = (
        error: unknown,
        cleanup: { destroySource: boolean; destroyGzip: boolean; destroyDestination: boolean }
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        unpipeStreams();
        if (cleanup.destroySource) {
          source.destroy();
        }
        if (cleanup.destroyGzip) {
          gzip.destroy();
        }
        if (cleanup.destroyDestination) {
          destination.destroy();
        }
        const failure = error instanceof Error ? error : new Error(String(error));
        // fs.createWriteStream opens its file asynchronously, and destroy()
        // lets a pending open finish before it closes the fd. Rejecting now
        // would let rotate() remove the temporary file before that late open
        // recreates it, so settle once the destination has closed, bounded
        // in case its open never returns.
        if (destination.closed) {
          reject(failure);
          return;
        }
        const closeWait = setTimeout(() => reject(failure), DESTINATION_CLOSE_WAIT_MS);
        closeWait.unref?.();
        destination.once('close', () => {
          clearTimeout(closeWait);
          reject(failure);
        });
      };

      const timeout = setTimeout(() => {
        rejectOnce(
          new Error(`Compression timed out after ${COMPRESSION_TIMEOUT_MS}ms`),
          { destroySource: true, destroyGzip: true, destroyDestination: true }
        );
      }, COMPRESSION_TIMEOUT_MS);
      timeout.unref?.();

      // Add error handlers to all streams to prevent hanging
      source.on('error', (error) => {
        rejectOnce(error, { destroySource: false, destroyGzip: true, destroyDestination: true });
      });

      gzip.on('error', (error) => {
        rejectOnce(error, { destroySource: true, destroyGzip: false, destroyDestination: true });
      });

      destination.on('error', (error) => {
        rejectOnce(error, { destroySource: true, destroyGzip: true, destroyDestination: false });
      });

      source
        .pipe(gzip)
        .pipe(destination);

      destination.on('finish', () => resolveOnce());
    });
  }

  /**
   * Get list of all rotated log files.
   */
  getRotatedLogs(): string[] {
    const dir = path.dirname(this.logPath);
    const baseName = path.basename(this.logPath);
    const logs: string[] = [];

    for (let i = 1; i <= this.retentionCount; i++) {
      const rotatedPath = path.join(dir, `${baseName}.${i}.gz`);
      if (fs.existsSync(rotatedPath)) {
        logs.push(rotatedPath);
      }
    }

    return logs;
  }
}
