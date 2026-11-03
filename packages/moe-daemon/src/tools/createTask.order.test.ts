import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { createTaskTool } from './createTask.js';
import { createEpicTool } from './createEpic.js';
import { isEpicFinalTask } from '../delivery/policy.js';
import type { Task } from '../types/schema.js';

// create_epic refuses a bad order and nextEpicOrder skips non-finite orders.
// create_task used to store order unchecked, and nextTaskOrder fed every stored
// order straight into Math.max, so one junk order made every later default NaN.
describe('moe.create_task order', () => {
  const h = new ToolTestHarness();
  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic({ id: 'epic-1' });
    h.createTask({ id: 'task-a', order: 1 });
    h.createTask({ id: 'task-b', order: 2 });
    await h.state.load();
  });
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const taskFiles = () => fs.readdirSync(path.join(h.moePath, 'tasks')).sort();
  const onDisk = (id: string) =>
    JSON.parse(fs.readFileSync(path.join(h.moePath, 'tasks', `${id}.json`), 'utf-8')) as { order: unknown };
  const create = (args: Record<string, unknown>) =>
    createTaskTool(h.state).handler({ epicId: 'epic-1', title: 'T', ...args }, h.state) as Promise<{ task: Task }>;

  it('(sibling) create_epic refuses order "abc" with INVALID_INPUT', async () => {
    await expect(createEpicTool(h.state).handler({ title: 'E', order: 'abc' }, h.state))
      .rejects.toMatchObject({ codeName: 'INVALID_INPUT', context: { field: 'order' } });
  });

  it('(r1) refuses order "abc" with INVALID_INPUT naming order', async () => {
    await expect(create({ order: 'abc' }))
      .rejects.toMatchObject({ codeName: 'INVALID_INPUT', context: { field: 'order' } });
  });

  it('(r2) after a refused string order the next default-order task is finite and the same on disk', async () => {
    await create({ order: 'abc' }).catch(() => undefined);
    const { task } = await create({});
    expect(task.order).toBe(3);
    expect(onDisk(task.id).order).toBe(3);
  });

  it('(r3) a legacy row with order "x" on disk gives the next default 3', async () => {
    h.createTask({ id: 'task-legacy', order: 'x' as unknown as number });
    await h.state.load();
    const { task } = await create({});
    expect(task.order).toBe(3);
  });

  it('(r4) the newest default-order row stays epic-final after a refused string order', async () => {
    await create({ order: 'abc' }).catch(() => undefined);
    const { task: finalRow } = await create({ title: 'integration and hardening' });
    expect(isEpicFinalTask(h.state, finalRow)).toBe(true);
    expect(isEpicFinalTask(h.state, h.state.getTask('task-b')!)).toBe(false);
  });

  describe('refusal matrix', () => {
    it.each([
      ['a string', 'abc'],
      ['a numeric string', '1'],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['null', null],
      ['an object', {}],
      ['an array', []],
      ['a boolean', true],
    ])('refuses %s with INVALID_INPUT and writes nothing', async (_label, value) => {
      const events: string[] = [];
      h.state.setEmitter((e) => events.push(e.type));
      const filesBefore = taskFiles();
      const countBefore = h.state.tasks.size;
      const err = await create({ order: value }).then(
        () => null,
        (e: unknown) => e as { codeName?: string; context?: { field?: string } },
      );
      expect(err, 'expected a refusal').not.toBeNull();
      expect(err?.codeName).toBe('INVALID_INPUT');
      expect(err?.context?.field).toBe('order');
      expect(h.state.tasks.size).toBe(countBefore);
      expect(taskFiles()).toEqual(filesBefore);
      expect(events).not.toContain('TASK_CREATED');
    });
  });

  describe('finite orders', () => {
    it.each([[231.164], [0], [-2.5]])('stores %s exactly, in memory and on disk', async (value) => {
      const { task } = await create({ order: value });
      expect(task.order).toBe(value);
      expect(h.state.getTask(task.id)?.order).toBe(value);
      expect(onDisk(task.id).order).toBe(value);
    });

    it('an omitted order still defaults to one more than the highest', async () => {
      const { task } = await create({});
      expect(task.order).toBe(3);
    });
  });

  describe('nextTaskOrder', () => {
    it('skips null and non-numeric stored orders', async () => {
      h.createTask({ id: 'task-x', order: 'x' as unknown as number });
      h.createTask({ id: 'task-n', order: null as unknown as number });
      await h.state.load();
      expect(h.state.nextTaskOrder('epic-1')).toBe(3);
    });

    it('defaults to 1 when every stored order is non-finite', async () => {
      h.createEpic({ id: 'epic-2' });
      h.createTask({ id: 'task-x', epicId: 'epic-2', order: 'x' as unknown as number });
      h.createTask({ id: 'task-n', epicId: 'epic-2', order: null as unknown as number });
      await h.state.load();
      expect(h.state.nextTaskOrder('epic-2')).toBe(1);
    });

    it('keeps fractional maxima: 231.164 + 1', async () => {
      await create({ order: 231.164 });
      expect(h.state.nextTaskOrder('epic-1')).toBe(232.164);
    });
  });
});
