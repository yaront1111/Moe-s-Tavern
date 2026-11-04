// =============================================================================
// FileWatcher - watches .moe for external changes
// =============================================================================

import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'fs';
import path from 'path';
import { logger } from '../util/logger.js';

export type FileChangeEvent = {
  type: 'add' | 'change' | 'unlink';
  path: string;
};

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingEvent: FileChangeEvent | null = null;
  private isProcessing = false;
  private stopped = false;
  private readonly debounceMs = 150;
  /** Self-write tokens: one entry and one expiry timer per path. */
  private ignorePaths = new Map<string, NodeJS.Timeout>();
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
    // Re-arm, never stack. An earlier call's timer must not delete the token a
    // later write to the same file just registered, or that write's event
    // reloads the whole store as an external edit (task-bed60fca).
    const prior = this.ignorePaths.get(normalized);
    if (prior) clearTimeout(prior);
    // Auto-expire after 500ms to prevent leaks; only the current token deletes itself.
    const t = setTimeout(() => {
      if (this.ignorePaths.get(normalized) === t) this.ignorePaths.delete(normalized);
    }, 500);
    if (t.unref) t.unref();
    this.ignorePaths.set(normalized, t);
  }

  start(): void {
    if (this.watcher) return;

    const root = this.watchRoot();
    const directories = new Set(['epics', 'tasks', 'workers', 'proposals', 'channels', 'pins', 'decisions']);
    // Chokidar 6 paths are literal, not globs. Watch the stable root so
    // entity directories created later are covered, without widening scope.
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      depth: 1,
      ignored: (filePath, stats) => {
        const relative = path.relative(root, filePath);
        if (!relative) return false;
        const parts = relative.split(path.sep);
        if (parts.length === 1) {
          if (parts[0] === 'project.json') return stats?.isDirectory() === true;
          return !directories.has(parts[0]) || stats?.isFile() === true;
        }
        return parts.length !== 2 || !directories.has(parts[0]) ||
          !parts[1].endsWith('.json') || stats?.isDirectory() === true;
      },
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
    const token = this.ignorePaths.get(normalized);
    if (token) {
      clearTimeout(token);
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
    for (const t of this.ignorePaths.values()) clearTimeout(t);
    this.ignorePaths.clear();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
  }
}
