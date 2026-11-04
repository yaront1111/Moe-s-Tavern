import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { createEpicTool } from './createEpic.js';
import { updateEpicTool } from './updateEpic.js';
import type { Epic } from '../types/schema.js';

// create_epic must answer a supplied status and order exactly as update_epic does
// (validateEpicUpdates): INVALID_INPUT naming the field, nothing written, no coercion.
describe('create_epic vs update_epic: status / order validation', () => {
  const h = new ToolTestHarness();
  const persisted = (): string =>
    JSON.stringify([Array.from(h.state.epics.keys()).sort(), fs.readdirSync(path.join(h.moePath, 'epics')).sort()]);

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic({ id: 'epic-1' });
    await h.state.load();
  });
  afterEach(() => h.cleanup());

  const bad: Array<[string, Record<string, unknown>]> = [
    ['status', { status: 'BOGUS' }],
    ['order', { order: 'abc' }],
    ['order', { order: -5 }],
    ['order', { order: 2.5 }],
  ];

  it('update_epic refuses each bad value (sibling baseline)', async () => {
    for (const [field, value] of bad) {
      await expect(updateEpicTool(h.state).handler({ epicId: 'epic-1', ...value }, h.state))
        .rejects.toMatchObject({ codeName: 'INVALID_INPUT', context: { field } });
    }
  });

  it('create_epic refuses each bad value through the tool and the state path, persisting nothing', async () => {
    const before = persisted();
    for (const [field, value] of bad) {
      await expect(createEpicTool(h.state).handler({ title: 'E', ...value }, h.state))
        .rejects.toMatchObject({ codeName: 'INVALID_INPUT', context: { field } });
      // The board's /ws CREATE_EPIC passes its payload straight to state.createEpic.
      await expect(h.state.createEpic({ title: 'E', ...value } as Partial<Epic>))
        .rejects.toMatchObject({ codeName: 'INVALID_INPUT', context: { field } });
    }
    expect(persisted()).toBe(before);
  });

  it('create_epic keeps ARCHIVED, the status its schema advertises', async () => {
    const r = (await createEpicTool(h.state).handler({ title: 'E', status: 'ARCHIVED' }, h.state)) as { epic: Epic };
    expect(r.epic.status).toBe('ARCHIVED');
  });

  it('an omitted or null status and order keep the defaults', async () => {
    const a = await h.state.createEpic({ title: 'A' });
    const b = await h.state.createEpic({ title: 'B', status: null, order: null } as unknown as Partial<Epic>);
    expect([a.status, a.order, b.status, b.order]).toEqual(['PLANNED', 2, 'PLANNED', 3]);
  });
});
