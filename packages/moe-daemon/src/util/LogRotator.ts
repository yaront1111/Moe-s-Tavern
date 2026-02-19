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

export interface LogRotatorOptions {
  maxSizeMB?: number;
  retentionCount?: number;
}

export class LogRotator {
  private readonly logPath: string;
  private readonly maxSizeBytes: number;
  private readonly retentionCount: number;

  constructor(logPath: string, options?: LogRotatorOptions) {
    this.logPath = logPath;

    // Read from env vars or use provided options or defaults
    const envMaxSize = process.env.LOG_MAX_SIZE_MB;
    const envRetention = process.env.LOG_RETENTION_COUNT;

    this.maxSizeBytes = (
      options?.maxSizeMB ??
      (envMaxSize ? parseInt(envMaxSize, 10) : DEFAULT_MAX_SIZE_MB)
    ) * 1024 * 1024;

    this.retentionCount =
      options?.retentionCount ??
      (envRetention ? parseInt(envRetention, 10) : DEFAULT_RETENTION_COUNT);
  }

  /**
   * Check if rotation is needed and perform it if so.
   * Should be called before appending to the log.
   */
  async rotateIfNeeded(): Promise<boolean> {
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
      logger.error({ error, logPath: this.logPath }, 'Failed to check/rotate log');
      return false;
    }
  }

  /**
   * Perform log rotation:
   * 1. Shift existing rotated logs (activity.log.2.gz -> activity.log.3.gz)
   * 2. Compress current log to activity.log.1.gz
   * 3. Truncate current log file
   * 4. Delete logs beyond retention count
   */
  private async rotate(): Promise<void> {
    logger.info({ logPath: this.logPath, maxSizeMB: this.maxSizeBytes / 1024 / 1024 }, 'Rotating activity log');

    const dir = path.dirname(this.logPath);
    const baseName = path.basename(this.logPath);

    // Delete oldest log if it would exceed retention
    const oldestLog = path.join(dir, `${baseName}.${this.retentionCount}.gz`);
    if (fs.existsSync(oldestLog)) {
      fs.unlinkSync(oldestLog);
    }

    // Shift existing rotated logs
    for (let i = this.retentionCount - 1; i >= 1; i--) {
      const oldPath = path.join(dir, `${baseName}.${i}.gz`);
      const newPath = path.join(dir, `${baseName}.${i + 1}.gz`);
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath);
      }
    }

    // Compress current log to .1.gz
    const compressedPath = path.join(dir, `${baseName}.1.gz`);
    await this.compressFile(this.logPath, compressedPath);

    // Truncate the current log file
    fs.writeFileSync(this.logPath, '');

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
        reject(error instanceof Error ? error : new Error(String(error)));
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
