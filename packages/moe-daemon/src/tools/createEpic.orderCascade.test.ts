import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { createEpicTool } from './createEpic.js';
import type { Epic } from '../types/schema.js';

// nextEpicOrder() is Math.max over every epic's order: one non-numeric order
// (an unchecked create, a legacy file, a hand edit) used to make every later
// default order NaN in memory and null on disk.
describe('create_epic: the default order stays finite', () => {
  const h = new ToolTestHarness();
  afterEach(() => h.cleanup());

  const createDefault = async (): Promise<{ inMemory: unknown; onDisk: unknown }> => {
    const r = (await createEpicTool(h.state).handler({ title: 'next' }, h.state)) as { epic: Epic };
    const file = JSON.parse(fs.readFileSync(path.join(h.moePath, 'epics', `${r.epic.id}.json`), 'utf8')) as { order: unknown };
    return { inMemory: r.epic.order, onDisk: file.order };
  };

  it('a refused string order does not poison the next default order', async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic({ id: 'epic-1', order: 1 });
    await h.state.load();
    await createEpicTool(h.state).handler({ title: 'bad', order: 'abc' }, h.state).catch(() => undefined);
    expect(await createDefault()).toEqual({ inMemory: 2, onDisk: 2 });
  });

  it.each([
    ['a string order', { order: 'abc' }],
    ['no order at all', { order: undefined }],
  ])('an epic file that already holds %s loads untouched and the next default order skips it', async (_label, legacy) => {
    h.init();
    h.setupMoeFolder();
    h.createEpic({ id: 'epic-1', order: 4 });
    h.createEpic({ id: 'epic-legacy', ...legacy } as unknown as Partial<Epic>);
    const legacyFile = path.join(h.moePath, 'epics', 'epic-legacy.json');
    const legacyBytes = fs.readFileSync(legacyFile, 'utf8');
    await h.state.load();
    expect(await createDefault()).toEqual({ inMemory: 5, onDisk: 5 });
    expect(fs.readFileSync(legacyFile, 'utf8')).toBe(legacyBytes);
  });
});
