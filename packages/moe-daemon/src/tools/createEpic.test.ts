import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { createEpicTool } from './createEpic.js';
import type { Epic } from '../types/schema.js';

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
});

