import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
import { FileWatcher } from './FileWatcher.js';

vi.mock('chokidar', () => ({ default: { watch: vi.fn() } }));

describe('FileWatcher canonical paths', () => {
  let scratch: string;
  let aliasRoot: string;
  let canonicalRoot: string;
  let events: EventEmitter;
  let watcher: FileWatcher;
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'moe watcher path '));
    const project = path.join(scratch, 'actual project');
    fs.mkdirSync(path.join(project, '.moe', 'tasks'), { recursive: true });
    const alias = path.join(scratch, 'alias project');
    fs.symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    aliasRoot = path.join(alias, '.moe');
    canonicalRoot = fs.realpathSync.native(aliasRoot);
    events = new EventEmitter();
    vi.mocked(chokidar.watch).mockReturnValue(Object.assign(events, {
      close: vi.fn().mockResolvedValue(undefined)
    }) as unknown as chokidar.FSWatcher);
    onChange = vi.fn();
    watcher = new FileWatcher(aliasRoot, onChange);
  });

  afterEach(async () => {
    await watcher.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('passes the native canonical root to chokidar instead of an alias', () => {
    const nativePath = vi.spyOn(fs.realpathSync, 'native');
    watcher.start();

    expect(nativePath).toHaveBeenCalledWith(path.resolve(aliasRoot));
    const patterns = vi.mocked(chokidar.watch).mock.lastCall![0] as string[];
    const root = canonicalRoot.split(path.sep).join('/');
    expect(patterns).toContain(`${root}/project.json`);
    expect(patterns).toContain(`${root}/tasks/*.json`);
    expect(patterns.every(pattern => pattern.startsWith(`${root}/`))).toBe(true);
  });

  for (const type of ['add', 'change', 'unlink'] as const) {
    it(`suppresses canonical ${type} events for a self-write through the original alias`, async () => {
      const file = path.join(canonicalRoot, 'tasks', 'self-write.json');
      fs.writeFileSync(file, '{}');
      watcher.start();
      watcher.ignorePath(path.join(aliasRoot, 'tasks', 'self-write.json'));
      if (type === 'unlink') fs.unlinkSync(file);

      events.emit(type, file);
      await vi.advanceTimersByTimeAsync(200);
      expect(onChange).not.toHaveBeenCalled();
    });
  }

  it('preserves suppression registered before start, including a file that does not exist', async () => {
    watcher.ignorePath(path.join(aliasRoot, 'tasks', 'new.json'));
    watcher.start();
    events.emit('add', path.join(canonicalRoot, 'tasks', 'new.json'));
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('delivers external changes and consumes each suppression only once', async () => {
    watcher.start();
    const file = path.join(canonicalRoot, 'tasks', 'shared.json');
    watcher.ignorePath(path.join(aliasRoot, 'tasks', 'shared.json'));
    events.emit('change', file);
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).not.toHaveBeenCalled();

    events.emit('change', file);
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ type: 'change', path: file });
  });

  it('does not suppress another directory with the same filename', async () => {
    watcher.start();
    watcher.ignorePath(path.join(`${aliasRoot}-other`, 'tasks', 'task.json'));
    const file = path.join(canonicalRoot, 'tasks', 'task.json');
    events.emit('change', file);
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ type: 'change', path: file });
  });
});
