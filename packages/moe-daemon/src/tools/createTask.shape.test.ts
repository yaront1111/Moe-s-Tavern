import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { createTaskTool } from './createTask.js';
import { MAX_EPIC_RAIL_CHARS } from '../state/validators.js';
import type { Task } from '../types/schema.js';

type Created = { success: boolean; task: Task; warnings?: string[] };

describe('moe.create_task input shape refusals', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    await h.state.load();
  });

  const tasksDir = () => path.join(h.moePath, 'tasks');
  const taskFiles = () => fs.readdirSync(tasksDir()).sort();

  /** Call create_task, assert INVALID_INPUT naming `field`, and that nothing was written. */
  async function expectRefused(extra: Record<string, unknown>, field: RegExp): Promise<void> {
    const events: string[] = [];
    h.state.setEmitter((e) => events.push(e.type));
    const filesBefore = taskFiles();
    const countBefore = h.state.tasks.size;
    const tool = createTaskTool(h.state);
    const err = await tool.handler({ epicId: 'epic-1', title: 'bug: x', ...extra }, h.state).then(
      () => null,
      (e: unknown) => e as { codeName?: string; message: string },
    );
    expect(err, 'expected a refusal').not.toBeNull();
    expect(err?.codeName).toBe('INVALID_INPUT');
    expect(err?.message).toMatch(field);
    expect(h.state.tasks.size).toBe(countBefore);
    expect(taskFiles()).toEqual(filesBefore);
    expect(events).not.toContain('TASK_CREATED');
  }

  async function create(extra: Record<string, unknown>): Promise<Created> {
    return createTaskTool(h.state).handler({ epicId: 'epic-1', title: 'bug: x', ...extra }, h.state) as Promise<Created>;
  }

  describe('definitionOfDone', () => {
    it.each([
      ['a plain string', 'Tests pass', /definitionOfDone/],
      ['a stringified JSON array', '["a","b"]', /definitionOfDone/],
      ['an object', { a: 1 }, /definitionOfDone/],
      ['an array holding a number', ['ok', 1], /definitionOfDone\[1\]/],
    ])('refuses %s', async (_label, value, field) => {
      await expectRefused({ definitionOfDone: value }, field);
    });

    it('a retry after a refusal creates exactly one row', async () => {
      await expectRefused({ definitionOfDone: 'Tests pass' }, /definitionOfDone/);
      const result = await create({ definitionOfDone: ['Tests pass'] });
      expect(result.success).toBe(true);
      const rows = Array.from(h.state.tasks.values()).filter((t) => t.title === 'bug: x');
      expect(rows).toHaveLength(1);
    });

    it('stores a valid array as given', async () => {
      const result = await create({ definitionOfDone: ['a', 'b', 'c'] });
      expect(result.task.definitionOfDone).toEqual(['a', 'b', 'c']);
      expect(result.warnings ?? []).not.toContainEqual(expect.stringContaining('definitionOfDone is empty'));
    });

    it('treats null as absent: placeholder and empty warning', async () => {
      const result = await create({ definitionOfDone: null });
      expect(result.task.definitionOfDone).toEqual(['Task completed as described']);
      expect(result.warnings).toContainEqual(expect.stringContaining('definitionOfDone is empty'));
    });

    it.each([[[]], [['']]])('keeps the placeholder and its warning for %j', async (value) => {
      const result = await create({ definitionOfDone: value });
      expect(result.task.definitionOfDone).toEqual(['Task completed as described']);
      expect(result.warnings).toContainEqual(expect.stringContaining('definitionOfDone is empty'));
    });
  });

  describe('taskRails', () => {
    it.each([
      ['a string', 'r', /taskRails/],
      ['an object', {}, /taskRails/],
      ['an array holding a number', [42], /taskRails\[0\]/],
      ['an array holding null', ['ok', null], /taskRails\[1\]/],
      ['an empty entry', [''], /taskRails\[0\]/],
      ['more than 100 entries', Array.from({ length: 101 }, (_, i) => `r${i}`), /taskRails/],
      ['an over-long entry', ['x'.repeat(MAX_EPIC_RAIL_CHARS + 1)], /taskRails\[0\]/],
    ])('refuses %s', async (_label, value, field) => {
      await expectRefused({ taskRails: value }, field);
    });

    it('accepts the exact boundary values', async () => {
      const long = 'x'.repeat(MAX_EPIC_RAIL_CHARS);
      const result = await create({ taskRails: [long] });
      expect(result.task.taskRails).toEqual([long]);
      const hundred = Array.from({ length: 100 }, (_, i) => `r${i}`);
      const second = (await createTaskTool(h.state).handler(
        { epicId: 'epic-1', title: 'bug: y', taskRails: hundred }, h.state,
      )) as Created;
      expect(second.task.taskRails).toEqual(hundred);
    });

    it('stores valid rails as given', async () => {
      const result = await create({ taskRails: ['r1'] });
      expect(result.task.taskRails).toEqual(['r1']);
    });

    it('treats null as absent', async () => {
      const result = await create({ taskRails: null });
      expect(result.task.taskRails).toEqual([]);
    });
  });
});
