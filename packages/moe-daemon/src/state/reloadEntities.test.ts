// StateManager.load() run again over a loaded state, as every FileWatcher change
// does: what it keeps when a file cannot be read, and what it reads at all.

import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';

describe('StateManager.load() as a reload', () => {
  const h = new ToolTestHarness();
  beforeEach(() => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
  });

  it('keeps a task whose file cannot be parsed right now (a checkout caught mid-write)', async () => {
    h.createTask({ id: 'task-1', title: 'Before the checkout' });
    await h.state.load();

    fs.writeFileSync(path.join(h.moePath, 'tasks', 'task-1.json'), '');
    await h.state.load();

    expect(h.state.getTask('task-1')).toMatchObject({ id: 'task-1', title: 'Before the checkout' });
  });

  it('still skips an unreadable file it never loaded', async () => {
    fs.writeFileSync(path.join(h.moePath, 'tasks', 'task-bad.json'), '{"id": "task-bad",');
    await h.state.load();

    expect(h.state.getTask('task-bad')).toBeNull();
  });

  it('reads a delivery record only when its file is new or changed', async () => {
    const dir = path.join(h.moePath, 'candidates');
    fs.mkdirSync(dir, { recursive: true });
    const write = (id: string, note: string): void =>
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, taskId: 'task-1', attemptId: 'attempt-1', note }));
    write('candidate-1', 'first');
    write('candidate-2', 'second');
    await h.state.load();
    const reads = vi.spyOn(fs, 'readFileSync');
    const candidateReads = (): string[] => reads.mock.calls
      .map(([file]) => String(file))
      .filter((file) => path.dirname(file) === dir)
      .map((file) => path.basename(file))
      .sort();

    await h.state.load();
    expect(candidateReads()).toEqual([]);

    write('candidate-1', 'first, rewritten');
    write('candidate-3', 'third');
    await h.state.load();

    expect(candidateReads()).toEqual(['candidate-1.json', 'candidate-3.json']);
    expect(h.state.candidates.get('candidate-1')).toMatchObject({ note: 'first, rewritten' });
    expect([...h.state.candidates.keys()].sort()).toEqual(['candidate-1', 'candidate-2', 'candidate-3']);
  });
});
