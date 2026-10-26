import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { updateEpicTool } from './updateEpic.js';
import { epicUpdatedActivityPayload } from '../state/validators.js';
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

  describe('finalTaskId designation', () => {
    beforeEach(async () => {
      h.createEpic({ id: 'epic-2' });
      h.createTask({ id: 'task-final', epicId: 'epic-1', order: 1 });
      h.createTask({ id: 'task-mid', epicId: 'epic-1', order: 2 });
      h.createTask({ id: 'task-elsewhere', epicId: 'epic-2', order: 1 });
      h.createTask({ id: 'task-archived', epicId: 'epic-1', order: 3, status: 'ARCHIVED' });
      await h.state.load();
    });

    const designate = (finalTaskId: unknown, extra: Record<string, unknown> = {}) =>
      updateEpicTool(h.state).handler({ epicId: 'epic-1', finalTaskId, ...extra }, h.state) as Promise<{ success: boolean; epic: Epic }>;

    it('persists a designated task of the epic across a reload', async () => {
      const result = await designate('task-final');

      expect(result.epic.finalTaskId).toBe('task-final');
      expect(h.state.getEpic('epic-1')?.finalTaskId).toBe('task-final');
      const onDisk = JSON.parse(fs.readFileSync(path.join(h.moePath, 'epics', 'epic-1.json'), 'utf-8')) as Epic;
      expect(onDisk.finalTaskId).toBe('task-final');
      await h.state.load();
      expect(h.state.getEpic('epic-1')?.finalTaskId).toBe('task-final');
    });

    it.each(['', '   '])('clears a set designation with %j', async (blank) => {
      await designate('task-final');

      await designate(blank);

      expect(h.state.getEpic('epic-1')?.finalTaskId).toBeUndefined();
      const onDisk = JSON.parse(fs.readFileSync(path.join(h.moePath, 'epics', 'epic-1.json'), 'utf-8')) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(onDisk, 'finalTaskId')).toBe(false);
    });

    it.each([
      ['an unknown id', 'task-nope', 'Invalid finalTaskId: names no task: task-nope'],
      ['a task of another epic', 'task-elsewhere', 'Invalid finalTaskId: task task-elsewhere belongs to epic epic-2, not epic-1'],
      ['an ARCHIVED task', 'task-archived', 'Invalid finalTaskId: task task-archived is ARCHIVED and can never be epic-final'],
    ])('rejects %s without writing anything', async (_label, id, message) => {
      await designate('task-final');

      await expect(designate(id, { title: 'Should Not Persist' })).rejects.toThrow(message);

      expect(h.state.getEpic('epic-1')?.title).toBe('Original Title');
      expect(h.state.getEpic('epic-1')?.finalTaskId).toBe('task-final');
    });

    it('rejects a non-string designation', async () => {
      await expect(designate(42)).rejects.toThrow('Invalid finalTaskId: must be a string');
      expect(h.state.getEpic('epic-1')?.finalTaskId).toBeUndefined();
    });

    it('stores a whitespace-padded valid id trimmed', async () => {
      await designate('  task-mid \t');

      expect(h.state.getEpic('epic-1')?.finalTaskId).toBe('task-mid');
    });

    it('records the designation in the EPIC_UPDATED activity payload', () => {
      expect(epicUpdatedActivityPayload({ ...h.state.getEpic('epic-1')!, finalTaskId: 'task-final' }, { finalTaskId: 'task-final' }))
        .toMatchObject({ changedFields: ['finalTaskId'], finalTaskId: 'task-final' });
      expect(epicUpdatedActivityPayload(h.state.getEpic('epic-1')!, { finalTaskId: undefined }))
        .toMatchObject({ changedFields: ['finalTaskId'], finalTaskId: null });
    });
  });
});

