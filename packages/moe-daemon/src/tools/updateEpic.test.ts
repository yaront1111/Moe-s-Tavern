import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { updateEpicTool } from './updateEpic.js';
import type { Epic } from '../types/schema.js';

describe('moe.update_epic', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic({ id: 'epic-1', title: 'Original Title' });
    await h.state.load();
  });

  it('updates epic title', async () => {
    const tool = updateEpicTool(h.state);
    const result = await tool.handler({
      epicId: 'epic-1',
      title: 'Updated Title',
    }, h.state) as { success: boolean; epic: Epic };

    expect(result.success).toBe(true);
    expect(result.epic.title).toBe('Updated Title');
  });

  it('updates multiple fields', async () => {
    const tool = updateEpicTool(h.state);
    const result = await tool.handler({
      epicId: 'epic-1',
      description: 'New desc',
      epicRails: ['Rule 1', 'Rule 2'],
      status: 'COMPLETED',
    }, h.state) as { success: boolean; epic: Epic };

    expect(result.success).toBe(true);
    expect(result.epic.description).toBe('New desc');
    expect(result.epic.epicRails).toEqual(['Rule 1', 'Rule 2']);
    expect(result.epic.status).toBe('COMPLETED');
  });

  it('throws for missing epicId', async () => {
    const tool = updateEpicTool(h.state);
    await expect(tool.handler({}, h.state)).rejects.toThrow('Missing required field: epicId');
  });

  it('rejects invalid updates without mutating the epic', async () => {
    const tool = updateEpicTool(h.state);

    await expect(tool.handler({
      epicId: 'epic-1',
      status: 'BROKEN',
      title: 'Should Not Persist',
    }, h.state)).rejects.toThrow('status');

    expect(h.state.getEpic('epic-1')?.title).toBe('Original Title');
  });

  it('rejects unknown epic update fields before applying allowed fields', async () => {
    const tool = updateEpicTool(h.state);

    await expect(tool.handler({
      epicId: 'epic-1',
      id: 'epic-evil',
      title: 'Should Not Persist',
    }, h.state)).rejects.toThrow('id');

    expect(h.state.getEpic('epic-1')?.id).toBe('epic-1');
    expect(h.state.getEpic('epic-1')?.title).toBe('Original Title');
  });
});

