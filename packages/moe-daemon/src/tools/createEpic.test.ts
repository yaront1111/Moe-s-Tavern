import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { createEpicTool } from './createEpic.js';
import fs from 'fs';
import path from 'path';
import type { Epic } from '../types/schema.js';
import { MAX_EPIC_RAIL_CHARS } from '../state/validators.js';

describe('moe.create_epic', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    await h.state.load();
  });

  it('creates a new epic', async () => {
    const tool = createEpicTool(h.state);
    const result = await tool.handler({
      title: 'New Epic',
      description: 'Epic desc',
    }, h.state) as { success: boolean; epic: Epic };

    expect(result.success).toBe(true);
    expect(result.epic.title).toBe('New Epic');
    expect(result.epic.status).toBe('PLANNED');
  });

  it('throws for missing title', async () => {
    const tool = createEpicTool(h.state);
    await expect(tool.handler({}, h.state)).rejects.toThrow('Missing required field: title');
  });
  describe('epicRails: same rule as update_epic, refuse never truncate', () => {
    const MAX = MAX_EPIC_RAIL_CHARS;
    let existing: Epic;
    let snapshot: string;
    let types: string[];

    const persisted = (): string => {
      const dir = path.join(h.moePath, 'epics');
      const files = fs.readdirSync(dir).sort().map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
      return JSON.stringify([Array.from(h.state.epics.keys()).sort(), files]);
    };

    beforeEach(async () => {
      existing = await h.state.createEpic({ title: 'Existing', epicRails: ['kept'] });
      snapshot = persisted();
      types = [];
      h.state.subscribe(e => { types.push(e.type); });
    });

    it('C1: refuses entries over the cap, through state and tool, persisting nothing', async () => {
      expect(MAX).toBe(10000);
      await expect(h.state.createEpic({ title: 'E', epicRails: ['ok', 'x'.repeat(MAX + 1)] }))
        .rejects.toMatchObject({ codeName: 'INVALID_INPUT', context: { field: 'epicRails[1]' } });
      await expect(createEpicTool(h.state).handler({ title: 'E', epicRails: ['y'.repeat(MAX + 1)] }, h.state))
        .rejects.toMatchObject({ codeName: 'INVALID_INPUT', context: { field: 'epicRails[0]' } });
      expect(persisted()).toBe(snapshot);
      expect(types).not.toContain('EPIC_CREATED');
    });

    it('C2: keeps rails byte-exact through the tool, the file and a reload', async () => {
      const rails = [
        'a'.repeat(1000),
        'b'.repeat(1500),
        'c'.repeat(MAX - 2) + '\u{1F680}',
        '  keep\tspaces and \u00fcn\u00efc\u00f6d\u00e9 \u{1F680}  ',
      ];
      expect(rails.slice(0, 3).map(r => r.length)).toEqual([1000, 1500, 10000]);
      const result = await createEpicTool(h.state).handler({ title: 'E', epicRails: rails }, h.state) as { epic: Epic };
      const id = result.epic.id;
      expect(result.epic.epicRails).toEqual(rails);
      const onDisk = JSON.parse(fs.readFileSync(path.join(h.moePath, 'epics', `${id}.json`), 'utf8')) as Epic;
      expect(onDisk.epicRails).toEqual(rails);
      await h.state.load();
      expect(h.state.getEpic(id)!.epicRails).toEqual(rails);
    });

    const refused: Array<[string, unknown, string]> = [
      ['non-string entry', ['ok', 42], 'epicRails[1]'],
      ['empty entry', ['ok', ''], 'epicRails[1]'],
      ['whitespace-only entry', ['ok', '  \t '], 'epicRails[1]'],
      ['NUL entry', ['ok', 'bad\u0000rail'], 'epicRails[1]'],
      ['newline entry', ['ok', 'bad\nrail'], 'epicRails[1]'],
      ['CR entry', ['ok', 'bad\rrail'], 'epicRails[1]'],
      ['101 entries', Array.from({ length: 101 }, (_, i) => `rail ${i}`), 'epicRails'],
      ['bare string', 'one rail', 'epicRails'],
      ['null', null, 'epicRails'],
    ];
    it.each(refused)('C3: refuses %s with update_epic parity', async (_name, bad, field) => {
      const createErr = await h.state.createEpic({ title: 'E', epicRails: bad as string[] })
        .then(() => null, (e: unknown) => e as { codeName?: string; context?: unknown });
      expect(createErr).toMatchObject({ codeName: 'INVALID_INPUT', context: { field } });
      expect(persisted()).toBe(snapshot);
      expect(types).not.toContain('EPIC_CREATED');
      const updateErr = await h.state.updateEpic(existing.id, { epicRails: bad as string[] })
        .then(() => null, (e: unknown) => e as { context?: unknown });
      expect(updateErr).not.toBeNull();
      expect(updateErr!.context).toEqual(createErr!.context);
      expect(h.state.getEpic(existing.id)!.epicRails).toEqual(['kept']);
    });

    it('C4: keeps exactly 100 entries in order; absent or empty gives []', async () => {
      const hundred = Array.from({ length: 100 }, (_, i) => `rail ${i}`);
      expect((await h.state.createEpic({ title: 'H', epicRails: hundred })).epicRails).toEqual(hundred);
      expect((await h.state.createEpic({ title: 'A' })).epicRails).toEqual([]);
      expect((await h.state.createEpic({ title: 'B', epicRails: [] })).epicRails).toEqual([]);
    });
  });
});

