import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { recordsWhere } from './recordIndex.js';
import { listReviewsForTask } from './reviewStore.js';
import type { StateManager } from './StateManager.js';

type Row = { id: string; taskId: string };

describe('recordsWhere', () => {
  const stateAt = (stateVersion: number): StateManager & { stateVersion: number } =>
    ({ stateVersion }) as StateManager & { stateVersion: number };
  const ids = (rows: Row[]): string[] => rows.map((row) => row.id);

  it('answers in insertion order and reads the store once until a write may have changed it', () => {
    const map = new Map<string, Row>([['a', { id: 'a', taskId: 't1' }], ['b', { id: 'b', taskId: 't2' }], ['c', { id: 'c', taskId: 't1' }]]);
    const values = vi.spyOn(map, 'values');
    const state = stateAt(1);

    expect(ids(recordsWhere(state, map, 'taskId', 't1'))).toEqual(['a', 'c']);
    expect(ids(recordsWhere(state, map, 'taskId', 't2'))).toEqual(['b']);
    expect(recordsWhere(state, map, 'taskId', 'none')).toEqual([]);
    expect(values).toHaveBeenCalledTimes(1);

    // A write bumps stateVersion, then its map.set lands.
    state.stateVersion = 2;
    map.set('d', { id: 'd', taskId: 't2' });
    expect(ids(recordsWhere(state, map, 'taskId', 't2'))).toEqual(['b', 'd']);
    expect(values).toHaveBeenCalledTimes(2);
  });

  it('rebuilds for a map.set that lands after the bump, and for a bucket naming a record that is gone', () => {
    const map = new Map<string, Row>([['a', { id: 'a', taskId: 't1' }], ['b', { id: 'b', taskId: 't2' }]]);
    const state = stateAt(1);
    expect(ids(recordsWhere(state, map, 'taskId', 't1'))).toEqual(['a']);

    map.set('c', { id: 'c', taskId: 't1' });
    expect(ids(recordsWhere(state, map, 'taskId', 't1'))).toEqual(['a', 'c']);

    map.delete('a');
    map.set('d', { id: 'd', taskId: 't3' });
    expect(ids(recordsWhere(state, map, 'taskId', 't1'))).toEqual(['c']);
    expect(ids(recordsWhere(state, map, 'taskId', 't3'))).toEqual(['d']);
  });
});

describe('the delivery stores look a task\'s records up through the index', () => {
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

  it('listing two tasks\' reviews reads the review store at most once, not once per task', async () => {
    const dir = path.join(h.moePath, 'reviews');
    fs.mkdirSync(dir, { recursive: true });
    const createdAt = new Date().toISOString();
    for (const [id, taskId] of [['review-1', 'task-1'], ['review-2', 'task-2'], ['review-3', 'task-1']]) {
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, taskId, candidateId: `candidate-${id}`, createdAt }));
    }
    await h.state.load();
    const values = vi.spyOn(h.state.reviews, 'values');

    expect(listReviewsForTask(h.state, 'task-1').map((review) => review.id)).toEqual(['review-1', 'review-3']);
    expect(listReviewsForTask(h.state, 'task-2').map((review) => review.id)).toEqual(['review-2']);
    expect(values.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
