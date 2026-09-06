// =============================================================================
// FileWatcher - watches .moe for external changes
// =============================================================================

import chokidar from 'chokidar';
import fs from 'fs';
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
  private canonicalMoePath: string | null = null;

  constructor(
    private readonly moePath: string,
    private readonly onChange: (event: FileChangeEvent) => void | Promise<void>
  ) {}

  private watchRoot(): string {
    // Windows 8.3 aliases can crash libuv's native watcher when a file arrives.
    // Resolve the existing directory before chokidar opens any native handles.
    return this.canonicalMoePath ??= fs.realpathSync.native(path.resolve(this.moePath));
  }

  private normalizeEventPath(filePath: string): string {
    const normalized = path.resolve(filePath);
    const relative = path.relative(path.resolve(this.moePath), normalized);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return normalized;
    }
    // State writes still use the caller's alias; chokidar emits canonical paths.
    // Map by the root so new and deleted files need not exist for suppression.
    return path.join(this.watchRoot(), relative);
  }

  /**
   * Mark a file path to be ignored on the next change event (self-write suppression).
   */
  ignorePath(filePath: string): void {
    const normalized = this.normalizeEventPath(filePath);
    this.ignorePaths.add(normalized);
    // Auto-expire after 500ms to prevent leaks
    const t = setTimeout(() => this.ignorePaths.delete(normalized), 500);
    if (t.unref) t.unref();
  }

  start(): void {
    if (this.watcher) return;

    const root = this.watchRoot().split(path.sep).join('/');
    const patterns = [
      `${root}/project.json`,
      `${root}/epics/*.json`,
      `${root}/tasks/*.json`,
      `${root}/workers/*.json`,
      `${root}/proposals/*.json`,
      `${root}/channels/*.json`,
      `${root}/pins/*.json`,
      `${root}/decisions/*.json`
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

    const normalized = this.normalizeEventPath(event.path);
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
