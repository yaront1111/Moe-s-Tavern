import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FileWatcher, type FileChangeEvent } from './FileWatcher.js';

// Self-write suppression, driven deterministically: the watcher is never
// started (no chokidar handles), and events enter through scheduleChange, the
// private method chokidar's add/change/unlink handlers call. Fake timers stand
// in for chokidar's latency, so the ordering below is exact (task-bed60fca).
describe('FileWatcher self-write suppression', () => {
  let testDir: string;
  let file: string;
  let events: FileChangeEvent[];
  let watcher: FileWatcher;

  const deliver = () =>
    (watcher as unknown as { scheduleChange(e: FileChangeEvent): void }).scheduleChange({ type: 'change', path: file });

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-selfwrite-'));
    const moePath = path.join(testDir, '.moe');
    fs.mkdirSync(path.join(moePath, 'tasks'), { recursive: true });
    file = path.join(moePath, 'tasks', 'task-a.json');
    events = [];
    vi.useFakeTimers();
    watcher = new FileWatcher(moePath, (e) => { events.push(e); });
  });

  afterEach(async () => {
    await watcher.stop();
    vi.useRealTimers();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('(s1) a second self-write 400 ms after the first stays suppressed after the first call\'s 500 ms expiry', async () => {
    watcher.ignorePath(file);                 // t=0    write 1
    await vi.advanceTimersByTimeAsync(200);
    deliver();                                // t=200  write 1's event: consumed
    await vi.advanceTimersByTimeAsync(200);
    watcher.ignorePath(file);                 // t=400  write 2, same file
    await vi.advanceTimersByTimeAsync(150);
    deliver();                                // t=550  write 2's event, after write 1's expiry
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([]);
  });

  it('(s2) a single self-write is suppressed', async () => {
    watcher.ignorePath(file);
    await vi.advanceTimersByTimeAsync(200);
    deliver();
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([]);
  });

  it('(s3) a change arriving after the 500 ms window, with no new ignorePath, reaches onChange exactly once', async () => {
    watcher.ignorePath(file);
    await vi.advanceTimersByTimeAsync(600);  // the token expires unused
    deliver();
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([{ type: 'change', path: file }]);
  });

  it('(s4) stop() leaves no suppression timer pending', async () => {
    watcher.ignorePath(file);
    await watcher.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
