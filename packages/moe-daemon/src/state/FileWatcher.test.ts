import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { FileWatcher, type FileChangeEvent } from './FileWatcher.js';
import { logger } from '../util/logger.js';

describe('FileWatcher', () => {
  let testDir: string;
  let moePath: string;
  let watcher: FileWatcher;
  let receivedEvents: FileChangeEvent[];

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-watcher-test-'));
    moePath = path.join(testDir, '.moe');
    fs.mkdirSync(moePath, { recursive: true });
    fs.mkdirSync(path.join(moePath, 'tasks'));
    fs.mkdirSync(path.join(moePath, 'epics'));
    receivedEvents = [];
  });

  afterEach(async () => {
    if (watcher) {
      await watcher.stop();
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('starts without error', () => {
    watcher = new FileWatcher(moePath, () => {});
    expect(() => watcher.start()).not.toThrow();
  });

  it('does not start twice', () => {
    watcher = new FileWatcher(moePath, () => {});
    watcher.start();
    watcher.start(); // Should be no-op
  });

  it('stops without error', async () => {
    watcher = new FileWatcher(moePath, () => {});
    watcher.start();
    await expect(watcher.stop()).resolves.not.toThrow();
  });

  it('handles stop when not started', async () => {
    watcher = new FileWatcher(moePath, () => {});
    await expect(watcher.stop()).resolves.not.toThrow();
  });

  it('detects file changes with debouncing', async () => {
    watcher = new FileWatcher(moePath, (event) => {
      receivedEvents.push(event);
    });
    watcher.start();

    // Wait for watcher to initialize
    await new Promise((r) => setTimeout(r, 200));

    // Create a new task file
    const taskFile = path.join(moePath, 'tasks', 'task-test.json');
    fs.writeFileSync(taskFile, JSON.stringify({ id: 'task-test' }));

    // Wait for debounce (150ms) + processing time
    await new Promise((r) => setTimeout(r, 400));

    expect(receivedEvents.length).toBeGreaterThanOrEqual(1);
    expect(receivedEvents[0].type).toBe('add');
    expect(receivedEvents[0].path).toContain('task-test.json');
  });

  it('coalesces rapid changes into single event', async () => {
    watcher = new FileWatcher(moePath, (event) => {
      receivedEvents.push(event);
    });
    watcher.start();

    await new Promise((r) => setTimeout(r, 200));

    // Make multiple rapid changes
    const taskFile = path.join(moePath, 'tasks', 'task-rapid.json');
    fs.writeFileSync(taskFile, JSON.stringify({ id: 'v1' }));
    fs.writeFileSync(taskFile, JSON.stringify({ id: 'v2' }));
    fs.writeFileSync(taskFile, JSON.stringify({ id: 'v3' }));

    await new Promise((r) => setTimeout(r, 400));

    // Should be coalesced - we may get 1-2 events due to debouncing
    // but definitely not 3 separate events
    expect(receivedEvents.length).toBeLessThanOrEqual(2);
  });

  it('handles onChange errors gracefully', async () => {
    const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    watcher = new FileWatcher(moePath, () => {
      throw new Error('Handler error');
    });
    watcher.start();

    await new Promise((r) => setTimeout(r, 200));

    const taskFile = path.join(moePath, 'tasks', 'task-error.json');
    fs.writeFileSync(taskFile, JSON.stringify({ id: 'test' }));

    await new Promise((r) => setTimeout(r, 400));

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'FileWatcher onChange error'
    );
    loggerSpy.mockRestore();
  });

  it('handles async onChange callback', async () => {
    let processed = false;
    watcher = new FileWatcher(moePath, async () => {
      await new Promise((r) => setTimeout(r, 50));
      processed = true;
    });
    watcher.start();

    await new Promise((r) => setTimeout(r, 200));

    const taskFile = path.join(moePath, 'tasks', 'task-async.json');
    fs.writeFileSync(taskFile, JSON.stringify({ id: 'test' }));

    await new Promise((r) => setTimeout(r, 500));

    expect(processed).toBe(true);
  });

  it('detects file deletions', async () => {
    // Create file first
    const taskFile = path.join(moePath, 'tasks', 'task-delete.json');
    fs.writeFileSync(taskFile, JSON.stringify({ id: 'test' }));

    watcher = new FileWatcher(moePath, (event) => {
      receivedEvents.push(event);
    });
    watcher.start();

    await new Promise((r) => setTimeout(r, 200));

    // Delete the file
    fs.unlinkSync(taskFile);

    await new Promise((r) => setTimeout(r, 400));

    const unlinkEvents = receivedEvents.filter((e) => e.type === 'unlink');
    expect(unlinkEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('watches correct file patterns', async () => {
    watcher = new FileWatcher(moePath, (event) => {
      receivedEvents.push(event);
    });
    watcher.start();

    await new Promise((r) => setTimeout(r, 200));

    // This should NOT trigger (not in watched pattern)
    const otherFile = path.join(moePath, 'other.txt');
    fs.writeFileSync(otherFile, 'test');

    // This SHOULD trigger
    const epicFile = path.join(moePath, 'epics', 'epic-test.json');
    fs.writeFileSync(epicFile, JSON.stringify({ id: 'epic-test' }));

    await new Promise((r) => setTimeout(r, 400));

    const epicEvents = receivedEvents.filter((e) => e.path.includes('epic-test.json'));
    expect(epicEvents.length).toBeGreaterThanOrEqual(1);

    const otherEvents = receivedEvents.filter((e) => e.path.includes('other.txt'));
    expect(otherEvents.length).toBe(0);
  });
});
