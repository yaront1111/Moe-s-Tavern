// =============================================================================
// FileWatcher - watches .moe for external changes
// =============================================================================

import chokidar from 'chokidar';
import path from 'path';
import { logger } from '../util/logger.js';

export type FileChangeEvent = {
  type: 'add' | 'change' | 'unlink';
  path: string;
};

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingEvent: FileChangeEvent | null = null;
  private isProcessing = false;
  private stopped = false;
  private readonly debounceMs = 150;
  private ignorePaths = new Set<string>();

  constructor(
    private readonly moePath: string,
    private readonly onChange: (event: FileChangeEvent) => void | Promise<void>
  ) {}

  /**
   * Mark a file path to be ignored on the next change event (self-write suppression).
   */
  ignorePath(filePath: string): void {
    const normalized = path.resolve(filePath);
    this.ignorePaths.add(normalized);
    // Auto-expire after 500ms to prevent leaks
    setTimeout(() => this.ignorePaths.delete(normalized), 500);
  }

  start(): void {
    if (this.watcher) return;

    const patterns = [
      `${this.moePath}/project.json`,
      `${this.moePath}/epics/*.json`,
      `${this.moePath}/tasks/*.json`,
      `${this.moePath}/workers/*.json`,
      `${this.moePath}/proposals/*.json`,
      `${this.moePath}/channels/*.json`,
      `${this.moePath}/pins/*.json`,
      `${this.moePath}/decisions/*.json`
    ];

    this.watcher = chokidar.watch(patterns, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100 }
    });

    const handleEvent = (type: 'add' | 'change' | 'unlink', path: string) => {
      this.scheduleChange({ type, path });
    };

    this.watcher.on('add', (path) => handleEvent('add', path));
    this.watcher.on('change', (path) => handleEvent('change', path));
    this.watcher.on('unlink', (path) => handleEvent('unlink', path));
    this.watcher.on('error', (error) => {
      logger.error({ error }, 'FileWatcher error');
    });
  }

  /**
   * Debounce file changes to prevent multiple rapid reloads.
   * Coalesces multiple changes into a single callback invocation.
   */
  private scheduleChange(event: FileChangeEvent): void {
    if (this.stopped) return;

    const normalized = path.resolve(event.path);
    if (this.ignorePaths.has(normalized)) {
      this.ignorePaths.delete(normalized);
      return; // Skip self-writes
    }

    this.pendingEvent = event;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      if (!this.stopped) this.processChange();
    }, this.debounceMs);
  }

  private async processChange(): Promise<void> {
    if (this.isProcessing || !this.pendingEvent) return;

    this.isProcessing = true;
    const event = this.pendingEvent;
    this.pendingEvent = null;

    try {
      await this.onChange(event);
    } catch (error) {
      logger.error({ error, event }, 'FileWatcher onChange error');
    } finally {
      this.isProcessing = false;

      // If another event came in while processing, schedule it
      if (this.pendingEvent) {
        this.scheduleChange(this.pendingEvent);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
  }
}
