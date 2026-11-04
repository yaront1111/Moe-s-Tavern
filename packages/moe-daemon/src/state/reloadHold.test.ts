import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { deregisterWorkerTool } from '../tools/deregisterWorker.js';
import { acquireResourceTool } from '../tools/acquireResource.js';
import type { ProjectSettings } from '../types/schema.js';
import { listAttempts } from './attemptStore.js';
import { checkReloadHolds, runReloadHoldSweep, startStaleWorkerWatcher } from './sweeps.js';
import { endReloadHold, resolveReloadHoldMs } from './workerLifecycle.js';

describe('wrapper reload hold', () => {
  const h = new ToolTestHarness();
  const workerId = 'worker-reload';
  const taskId = 'task-1';
  const claim = (id = workerId, explicit?: string) => claimNextTaskTool(h.state).handler(
    { statuses: ['WORKING'], workerId: id, ...(explicit ? { taskId: explicit } : {}) }, h.state);
  const deregister = (reason = 'wrapper_restart', id = workerId) =>
    deregisterWorkerTool(h.state).handler({ workerId: id, reason }, h.state);
  const deadline = () => Date.parse(h.state.getWorker(workerId)!.reloadHoldUntil!);
  const sweep = (now: number) => h.state.runExclusive(() => runReloadHoldSweep(h.state, now));
  const outcome = (task = taskId, worker = workerId) => [h.state.getTask(task)?.status,
    h.state.getTask(task)?.assignedWorkerId, listAttempts(h.state, task).map(a => a.phase),
    h.state.getWorker(worker)?.status];
  async function peer(id = 'worker-peer') {
    await h.state.createWorker({ id, type: 'CODEX', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE' });
    const team = await h.state.createTeam({ name: id, role: 'worker' });
    await h.state.addTeamMember(team.id, id);
    return id;
  }

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ status: 'WORKING' });
    await h.state.load();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);
    vi.spyOn(h.state, 'postToGeneral').mockResolvedValue(undefined);
    await claim();
    vi.mocked(h.state.postToRoleChannel).mockClear();
  });
  afterEach(() => {
    h.state.clearEmitter();
    vi.restoreAllMocks();
    h.cleanup();
  });

  it('retains the task and running attempt during a wrapper restart', async () => {
    h.state.project!.settings.resources = { reload: { capacity: 1, releaseOnDeregister: true } };
    await acquireResourceTool(h.state).handler({ workerId, taskId, resourceId: 'reload' }, h.state);
    const team = await h.state.createTeam({ name: 'reload', role: 'worker' });
    await h.state.addTeamMember(team.id, workerId);
    const general = Array.from(h.state.channels.values()).find(channel => channel.type === 'general')!;
    await h.state.updateWorker(workerId, { chatCursors: { [general.id]: 'last-message' } });
    const before = h.state.getWorker(workerId);
    const task = h.state.getTask(taskId);
    const attempts = listAttempts(h.state, taskId);
    const resource = structuredClone(h.state.getResource('reload'));
    const leaves = vi.spyOn(h.state, 'sendMessage');
    const activity = vi.spyOn(h.state, 'appendActivity');
    const now = Date.now();
    const result = await deregister();
    const holdUntil = h.state.getWorker(workerId)!.reloadHoldUntil;
    expect(result).toEqual({ success: true, workerId, alreadyDead: false, heldTaskIds: [taskId],
      releasedTaskIds: [], releasedCount: 0, holdUntil,
      message: `${workerId} reloading; holding 1 task(s) for its relaunch until ${holdUntil}` });
    expect(deadline()).toBeGreaterThanOrEqual(now + 120000);
    expect(deadline()).toBeLessThanOrEqual(Date.now() + 120000);
    expect(h.state.getTask(taskId)).toEqual(task);
    expect(listAttempts(h.state, taskId)).toEqual(attempts);
    expect(outcome()).toEqual(['WORKING', workerId, ['running'], 'READING_CONTEXT']);
    expect(h.state.getWorker(workerId)).toEqual({ ...before, reloadHoldUntil: holdUntil,
      lastActivityAt: expect.any(String) });
    expect(h.state.getResource('reload')).toEqual(resource);
    expect(leaves).not.toHaveBeenCalled();
    const banner = `🔌 ${workerId} reloading (wrapper_restart); holding 1 task(s) for its relaunch until ${holdUntil}: ${taskId}(WORKING)`;
    expect(vi.mocked(h.state.postToRoleChannel).mock.calls).toEqual([['workers', banner], ['governors', banner]]);
    expect(activity.mock.calls.filter(c => c[0] === 'WORKER_DISCONNECTED')).toEqual([
      ['WORKER_DISCONNECTED', { workerId, reason: 'wrapper_restart', releasedTaskIds: [],
        heldTaskIds: [taskId], holdUntil }, undefined, before] ]);
  });

  it('excludes peers until the returning seat clears the hold', async () => {
    const other = await peer();
    await deregister();
    const until = deadline();
    const ranked = await claim(other);
    expect(ranked).toMatchObject({ hasNext: false });
    expect(ranked).not.toHaveProperty('task');
    expect(ranked).not.toHaveProperty('alreadyAssigned');
    await expect(claim(other, taskId)).rejects.toThrow(/already assigned/);
    expect(await claim()).toMatchObject({ hasNext: false, alreadyAssigned: { taskId } });
    expect(h.state.getWorker(workerId)?.reloadHoldUntil).toBeNull();
    expect(await sweep(until + 1)).toEqual([]);
    expect(outcome()).toEqual(['WORKING', workerId, ['running'], 'READING_CONTEXT']);
  });

  it('expires at the deadline to the same end state as terminal_closed', async () => {
    h.createEpic({ id: 'epic-other' });
    h.createTask({ id: 'task-control', epicId: 'epic-other', status: 'WORKING' });
    await h.state.load();
    await claim('worker-control', 'task-control');
    await deregister('terminal_closed', 'worker-control');
    const other = await peer();
    await deregister();
    const until = deadline();
    expect(await sweep(until - 1)).toEqual([]);
    expect(outcome()).toEqual(['WORKING', workerId, ['running'], 'READING_CONTEXT']);
    expect(await sweep(until)).toEqual([workerId]);
    expect(outcome()).toEqual(outcome('task-control', 'worker-control'));
    expect(outcome()).toEqual(['WORKING', null, ['closed'], 'DEAD']);
    expect(h.state.getWorker(workerId)?.reloadHoldUntil).toBeNull();
    expect(await claim(other)).toMatchObject({ hasNext: true, task: { id: taskId } });
  });

  it.each([
    [undefined, 120000], [0, 0], [5000, 5000], [1800001, 1800000], [5e6, 1800000],
    [-1, 120000], [NaN, 120000], [Infinity, 120000], ['5000', 120000],
  ])('resolves reloadHoldMs %s to %s', (value, expected) => {
    const settings = { reloadHoldMs: value } as Pick<ProjectSettings, 'reloadHoldMs'>;
    expect(resolveReloadHoldMs(settings)).toBe(expected);
    expect(resolveReloadHoldMs()).toBe(120000);
  });

  it('releases immediately when the hold is disabled', async () => {
    h.state.project!.settings.reloadHoldMs = 0;
    const result = await deregister();
    expect(result).toMatchObject({ heldTaskIds: [], releasedTaskIds: [taskId] });
    expect(result).not.toHaveProperty('holdUntil');
    expect(h.state.getWorker(workerId)).not.toHaveProperty('reloadHoldUntil');
    expect(outcome()).toEqual(['WORKING', null, ['closed'], 'DEAD']);
  });

  it('releases immediately for a terminal close during a hold', async () => {
    await deregister();
    expect(await deregister('terminal_closed')).toMatchObject({ heldTaskIds: [], releasedTaskIds: [taskId] });
    expect(h.state.getWorker(workerId)?.reloadHoldUntil).toBeNull();
    expect(outcome()).toEqual(['WORKING', null, ['closed'], 'DEAD']);
  });

  it('repeats a hold without writes, banners, activity or extending the deadline', async () => {
    const first = await deregister();
    const update = vi.spyOn(h.state, 'updateWorker');
    const activity = vi.spyOn(h.state, 'appendActivity');
    vi.mocked(h.state.postToRoleChannel).mockClear();
    expect(await deregister()).toEqual(first);
    expect(update).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    expect(h.state.postToRoleChannel).not.toHaveBeenCalled();
  });

  it('deregisters idle seats without a hold or changed banner', async () => {
    const id = await peer();
    expect(await deregister('wrapper_restart', id)).toMatchObject({ heldTaskIds: [], releasedTaskIds: [] });
    expect(h.state.getWorker(id)?.status).toBe('DEAD');
    expect(h.state.getWorker(id)).not.toHaveProperty('reloadHoldUntil');
    expect(h.state.postToRoleChannel).toHaveBeenCalledWith('workers',
      `🔌 ${id} deregistered (wrapper_restart); (no tasks held)`);
  });

  it('releases if recording the hold fails', async () => {
    vi.spyOn(h.state, 'updateWorker').mockRejectedValueOnce(new Error('write failed'));
    expect(await deregister()).toMatchObject({ heldTaskIds: [], releasedTaskIds: [taskId] });
    expect(outcome()).toEqual(['WORKING', null, ['closed'], 'DEAD']);
  });

  it('fails the returning claim if clearing the hold fails', async () => {
    await deregister();
    const until = deadline();
    vi.spyOn(h.state, 'updateWorker').mockRejectedValueOnce(new Error('clear failed'));
    await expect(claim()).rejects.toThrow('clear failed');
    expect(deadline()).toBe(until);
    expect(outcome()).toEqual(['WORKING', workerId, ['running'], 'READING_CONTEXT']);
  });

  it('makes no write when a hold is absent', async () => {
    const update = vi.spyOn(h.state, 'updateWorker');
    for (const id of [undefined, 'worker-missing', workerId]) await endReloadHold(h.state, id);
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['invalid', ''])('expires malformed deadline %j', async reloadHoldUntil => {
    await h.state.updateWorker(workerId, { reloadHoldUntil });
    expect(await checkReloadHolds(h.state)).toEqual([workerId]);
    expect(outcome()).toEqual(['WORKING', null, ['closed'], 'DEAD']);
  });

  it('retries an expired hold whose DEAD write failed', async () => {
    await deregister();
    const until = deadline();
    vi.spyOn(h.state, 'updateWorker').mockRejectedValueOnce(new Error('DEAD write failed'));
    await sweep(until);
    expect(deadline()).toBe(until);
    expect(await sweep(until + 1)).toEqual([workerId]);
    expect(h.state.getWorker(workerId)).toMatchObject({ status: 'DEAD', reloadHoldUntil: null });
  });

  it('continues to another expired worker after a record fails', async () => {
    const other = await peer();
    await deregister();
    await h.state.updateWorker(other, { reloadHoldUntil: 'invalid' });
    const until = deadline();
    vi.spyOn(h.state, 'getWorker').mockImplementationOnce(() => { throw new Error('read failed'); });
    expect(await checkReloadHolds(h.state, until)).toEqual([other]);
    expect(h.state.getWorker(other)).toMatchObject({ status: 'DEAD', reloadHoldUntil: null });
    expect(await checkReloadHolds(h.state, deadline())).toEqual([workerId]);
  });

  it('serializes expiry behind the returning claim clear', async () => {
    await deregister();
    const until = deadline();
    let expiry!: Promise<string[]>;
    await h.state.runExclusive(async () => {
      expiry = h.state.mutex.exit(() => checkReloadHolds(h.state, until));
      await claim();
    });
    expect(await expiry).toEqual([]);
    expect(outcome()).toEqual(['WORKING', workerId, ['running'], 'READING_CONTEXT']);
  });

  it('expires persisted holds from the watcher without a governor', async () => {
    await deregister();
    const until = deadline();
    await h.state.load();
    await h.state.purgeAllWorkers();
    expect(deadline()).toBe(until);
    await h.state.updateWorker(workerId, { reloadHoldUntil: new Date(Date.now() - 1).toISOString() });
    startStaleWorkerWatcher(h.state, 5);
    await vi.waitFor(() => expect(h.state.getWorker(workerId)).toMatchObject({ status: 'DEAD', reloadHoldUntil: null }));
    expect(outcome()).toEqual(['WORKING', null, ['closed'], 'DEAD']);
  });
});
