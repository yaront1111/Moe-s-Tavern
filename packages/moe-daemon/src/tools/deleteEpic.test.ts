import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { deleteEpicTool } from './deleteEpic.js';
import type { Epic } from '../types/schema.js';

describe('moe.delete_epic', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic({ id: 'epic-1' });
    await h.state.load();
  });

  it('deletes epic without tasks', async () => {
    const tool = deleteEpicTool(h.state);
    const result = await tool.handler({ epicId: 'epic-1' }, h.state) as {
      success: boolean;
      deletedEpic: Epic;
      deletedTaskCount: number;
    };

    expect(result.success).toBe(true);
    expect(result.deletedEpic.id).toBe('epic-1');
    expect(result.deletedTaskCount).toBe(0);
  });

  it('throws when epic has tasks and cascadeDelete is false', async () => {
    h.createTask({ epicId: 'epic-1' });
    await h.state.load();

    const tool = deleteEpicTool(h.state);
    await expect(
      tool.handler({ epicId: 'epic-1', cascadeDelete: false }, h.state)
    ).rejects.toThrow('has 1 task(s)');
  });

  it('deletes epic and tasks when cascadeDelete is true', async () => {
    h.createTask({ epicId: 'epic-1' });
    await h.state.load();

    const tool = deleteEpicTool(h.state);
    const result = await tool.handler({
      epicId: 'epic-1',
      cascadeDelete: true,
    }, h.state) as { success: boolean; deletedTaskCount: number };

    expect(result.success).toBe(true);
    expect(result.deletedTaskCount).toBe(1);
  });

  it('throws for missing epicId', async () => {
    const tool = deleteEpicTool(h.state);
    await expect(tool.handler({}, h.state)).rejects.toThrow('Missing required field: epicId');
  });
});

