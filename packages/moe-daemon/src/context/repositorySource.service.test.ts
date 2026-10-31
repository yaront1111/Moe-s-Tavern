import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { MoeErrorCode } from '../util/errors.js';
import type { PlanPathGitRunner } from '../util/cachedPlanPaths.js';
import * as source from './repositorySource.js';

const h = new ToolTestHarness();
const commit = 'a'.repeat(40);
const request = { taskId: 'task-1', commit, queries: [{ id: 'read', purpose: 'source' as const, op: 'read' as const, path: 'a' }] };
const output = { stdout: Buffer.from('hello'), truncated: false, exitCode: 0, stderr: '' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function runners(park = false) {
  const entered = deferred(); const release = deferred();
  const run = vi.fn<PlanPathGitRunner>(async args => args.includes('--show-toplevel') ? fs.realpathSync(h.testDir)
    : args[0] === 'config' ? '' : args.includes('--verify') ? commit : `100644 blob ${'b'.repeat(40)} 5\ta\0`);
  const head = vi.fn(async () => { entered.resolve(); if (park) await release.promise; return output; });
  return { run, head, entered, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('mutex remained locked')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
beforeEach(async () => { h.init(); h.setupMoeFolder(); h.createTask(); await h.state.load(); });
afterEach(() => { h.state.clearEmitter(); h.cleanup(); vi.restoreAllMocks(); });

describe('repository source service', () => {
  it('rejects analysis under the state mutex before reading tasks or spawning', async () => {
    const r = runners(); const getTask = vi.spyOn(h.state, 'getTask');
    await expect(h.state.runExclusive(() => source.serveRepositorySource(h.state, request, r))).rejects.toMatchObject({
      code: MoeErrorCode.NOT_ALLOWED, codeName: 'SOURCE_ANALYSIS_UNDER_MUTEX',
    });
    expect(getTask).not.toHaveBeenCalled(); expect(r.run).not.toHaveBeenCalled(); expect(r.head).not.toHaveBeenCalled();
  });
  it('leaves the fleet mutex free while external analysis is parked', async () => {
    const r = runners(true); const pending = source.serveRepositorySource(h.state, request, r);
    try {
      await bounded(r.entered.promise);
      expect(await bounded(h.state.runExclusive(async () => 'free'))).toBe('free');
    } finally { r.release.resolve(); await pending; }
  });
  it('discards results when the plan revision changes during analysis', async () => {
    const r = runners(true); const pending = source.serveRepositorySource(h.state, request, r);
    await bounded(r.entered.promise);
    await h.state.updateTask('task-1', { definitionOfDone: ['changed'] });
    r.release.resolve();
    await expect(pending).rejects.toMatchObject({ code: MoeErrorCode.STATE_CONFLICT, codeName: 'SOURCE_REVISION_CHANGED',
      context: { taskId: 'task-1', servedForRevision: 0, currentPlanRevision: 1 } });
  });
  it('permits an unrelated priority change while parked', async () => {
    const r = runners(true); const pending = source.serveRepositorySource(h.state, request, r);
    await bounded(r.entered.promise); await h.state.updateTask('task-1', { priority: 'LOW' }); r.release.resolve();
    expect(await pending).toMatchObject({ taskId: 'task-1', planRevision: 0, items: [{ status: 'served', content: 'hello' }] });
  });
  it('rejects a task deleted during analysis', async () => {
    const r = runners(true); const pending = source.serveRepositorySource(h.state, request, r);
    await bounded(r.entered.promise); await h.state.deleteTask('task-1'); r.release.resolve();
    await expect(pending).rejects.toMatchObject({ code: MoeErrorCode.NOT_FOUND, codeName: 'TASK_NOT_FOUND' });
  });
  it('refuses an expected revision mismatch before starting Git', async () => {
    const r = runners();
    await expect(source.serveRepositorySource(h.state, { ...request, expectedPlanRevision: 1 }, r)).rejects.toMatchObject({
      code: MoeErrorCode.STATE_CONFLICT, codeName: 'SOURCE_REVISION_MISMATCH',
    }); expect(r.run).not.toHaveBeenCalled();
  });
  it.each([-1, 1.5, '1', null])('refuses invalid expected revision %s', async expectedPlanRevision => {
    const r = runners();
    await expect(source.serveRepositorySource(h.state, { ...request, expectedPlanRevision: expectedPlanRevision as number }, r)).rejects.toMatchObject({
      code: MoeErrorCode.INVALID_INPUT, codeName: 'INVALID_INPUT', context: { field: 'expectedPlanRevision' },
    }); expect(r.run).not.toHaveBeenCalled();
  });
  it('serves legacy revision zero without changing task JSON on disk', async () => {
    const file = path.join(h.moePath, 'tasks', 'task-1.json'); const before = fs.readFileSync(file);
    expect(await source.serveRepositorySource(h.state, request, runners())).toMatchObject({ taskId: 'task-1', planRevision: 0, complete: true });
    expect(fs.readFileSync(file)).toEqual(before);
  });
  it.each(['x', -1])('fails closed on corrupt stored revision %s', async revision => {
    h.createTask({ planRevision: revision as number }); await h.state.load(); const r = runners();
    await expect(source.serveRepositorySource(h.state, request, r)).rejects.toMatchObject({
      code: MoeErrorCode.INVALID_INPUT, codeName: 'INVALID_INPUT', context: { field: 'planRevision' },
    }); expect(r.run).not.toHaveBeenCalled();
  });
  it('refuses an unknown task before starting Git', async () => {
    const r = runners();
    await expect(source.serveRepositorySource(h.state, { ...request, taskId: 'missing' }, r)).rejects.toMatchObject({
      code: MoeErrorCode.NOT_FOUND, codeName: 'TASK_NOT_FOUND',
    }); expect(r.run).not.toHaveBeenCalled();
  });
});

it('shares the four default Git slots across two concurrent serves', async () => {
  const gate = deferred(); const entered = deferred(); let active = 0; let maximum = 0; let started = 0;
  const r = runners();
  const head = async () => {
    active++; maximum = Math.max(maximum, active); if (++started === 4) entered.resolve();
    await gate.promise; active--; return output;
  };
  const queries = Array.from({ length: 6 }, (_, i) => ({ ...request.queries[0], id: String(i) }));
  const calls = [0, 1].map(() => source.serveRepositorySource(h.state, { ...request, queries }, { ...r, head }));
  try { await bounded(entered.promise); expect(started).toBe(4); } finally { gate.resolve(); }
  const results = await Promise.all(calls);
  expect(maximum).toBe(4); expect(results.map(r => r.items.length)).toEqual([6, 6]);
  expect(results.every(r => r.complete)).toBe(true);
});

it('captures validated service inputs before waiting for the revision lock', async () => {
  const gate = deferred(); const entered = deferred();
  const lock = h.state.runExclusive(async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  const mutable = { ...request, queries: request.queries.map(q => ({ ...q })) };
  const pending = source.serveRepositorySource(h.state, mutable, runners());
  mutable.queries[0].path = '../changed'; gate.resolve(); await lock;
  expect((await pending).items[0]).toMatchObject({ path: 'a', status: 'served', content: 'hello' });
});
