import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { completeTaskTool } from '../tools/completeTask.js';
import { activeResourceWaiters, waitForResourceTool } from '../tools/waitForResource.js';
import { currentAttempt, openAttempt, setAttemptPhase } from './attemptStore.js';
import { logger } from '../util/logger.js';
import type { ExecutionAttemptPhase, ResourceState } from '../types/schema.js';

// A worktree completion takes the git-land lease AFTER moe.complete_task has
// moved the row to REVIEW and cleared its assignee. If another landing holds
// the lease, the wrapper queues and parks in wait_for_resource. The grant used
// to pass that entry over (no assignee, so no live seat "held" the row): the
// completion waited out its own wait while later landings acquired past it.
// The entry's own seat owning the task's finalizing attempt is that landing
// window, so the grant now treats the row as held.
describe('a queued landing whose task complete_task already unassigned', () => {
  const h = new ToolTestHarness();
  const RID = 'git-land-moe-work-2026-10-24';

  /** The handler persists its queue entry before it registers its waiter, so poll. */
  async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('waitFor: condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeEach(() => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 });
    h.createEpic();
    // The landing holder: a live seat on a WORKING row.
    h.createTask({ id: 'task-a', status: 'WORKING', assignedWorkerId: 'worker-a', order: 1 });
    h.createWorker({ id: 'worker-a', status: 'CODING', currentTaskId: 'task-a' });
  });

  afterEach(() => {
    // Resolve any parked waiter so vitest never hangs on a leaked promise.
    for (const [workerId, waiter] of activeResourceWaiters.entries()) {
      clearTimeout(waiter.timer);
      waiter.unsubscribe();
      waiter.resolve({ granted: false, cancelled: true });
      activeResourceWaiters.delete(workerId);
    }
    h.state.clearEmitter();
    vi.restoreAllMocks();
    h.cleanup();
  });

  async function loadState(): Promise<void> {
    await h.state.load();
    vi.spyOn(h.state, 'postToGeneral').mockResolvedValue();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue();
    vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue();
  }

  function readResource(): ResourceState {
    return JSON.parse(fs.readFileSync(path.join(h.moePath, 'resources', `${RID}.json`), 'utf8'));
  }

  it('grants the landing as the holder releases, and wakes its parked wait_for_resource', async () => {
    h.createTask({
      id: 'task-b', status: 'WORKING', assignedWorkerId: 'worker-b', order: 2,
      implementationPlan: [{ stepId: 'step-1', description: 'x', status: 'COMPLETED', affectedFiles: [] }],
    });
    h.createWorker({ id: 'worker-b', status: 'CODING', currentTaskId: 'task-b' });
    await loadState();
    await openAttempt(h.state, { taskId: 'task-b', workerId: 'worker-b', runnerId: 'runner-b', workspace: h.testDir });
    // 13:54:56Z: another landing holds git-land.
    const acquired = await h.state.acquireResource({ resourceId: RID, taskId: 'task-a', workerId: 'worker-a' });
    expect(acquired.granted).toBe(true);

    // 13:54:54Z: B completes through the real tool. It leaves the row in REVIEW,
    // unassigned, with the attempt finalizing and the seat idle.
    await completeTaskTool(h.state).handler(
      { taskId: 'task-b', workerId: 'worker-b', verification: { command: 'npm test', exitCode: 0 } }, h.state);
    expect(h.state.getTask('task-b')).toMatchObject({ status: 'REVIEW', assignedWorkerId: null });
    expect(currentAttempt(h.state, 'task-b')).toMatchObject({ phase: 'finalizing', workerId: 'worker-b' });
    expect(h.state.getWorker('worker-b')).toMatchObject({ status: 'IDLE', currentTaskId: null });

    // 13:55:17Z: the wrapper queues behind A and parks.
    const queued = await h.state.acquireResource({ resourceId: RID, taskId: 'task-b', workerId: 'worker-b' });
    expect(queued).toMatchObject({ granted: false, position: 1 });
    const parked = waitForResourceTool(h.state).handler(
      { resourceId: RID, taskId: 'task-b', workerId: 'worker-b', timeoutMs: 5000 }, h.state,
    ) as Promise<Record<string, unknown>>;
    await waitFor(() => activeResourceWaiters.has('worker-b'));
    const activity = vi.spyOn(h.state, 'appendActivity');

    // 13:55:24Z: A releases.
    const result = await h.state.releaseResource({ resourceId: RID, workerId: 'worker-a' });

    expect(result.granted.map((lease) => [lease.taskId, lease.workerId])).toEqual([['task-b', 'worker-b']]);
    const persisted = readResource();
    expect(persisted.holders.map((lease) => lease.taskId)).toEqual(['task-b']);
    expect(persisted.queue).toEqual([]);
    expect(activity).toHaveBeenCalledWith('RESOURCE_GRANTED', { resourceId: RID, taskId: 'task-b', workerId: 'worker-b' });
    const woken = await parked;
    expect(woken.granted).toBe(true);
    expect((woken.lease as { taskId: string }).taskId).toBe('task-b');
    expect(activeResourceWaiters.size).toBe(0);
  });

  // The landing rule needs a registered, non-DEAD requester that owns the
  // task's OPEN attempt in `finalizing`. Everything else keeps today's
  // pass-over: the slot goes to the next live waiter and the entry keeps its age.
  interface Seed {
    /** The record for the queue entry's own seat (worker-r). */
    requester: 'live' | 'DEAD' | 'absent';
    /** An attempt opened on task-r after load, then moved to `phase`. */
    attempt: { workerId: string; phase: ExecutionAttemptPhase } | null;
    /** A hand-written attempt record with no workerId, on disk before load. */
    malformedRecord?: boolean;
    /** Make the attempt read throw, right before the release. */
    unreadable?: boolean;
    /** The phase of the task's open attempt once seeded, null when none is open. */
    open: ExecutionAttemptPhase | null;
  }
  const SEEDS: Array<[string, Seed]> = [
    ['no attempt', { requester: 'live', attempt: null, open: null }],
    ['closed attempt', { requester: 'live', attempt: { workerId: 'worker-r', phase: 'closed' }, open: null }],
    ['running attempt', { requester: 'live', attempt: { workerId: 'worker-r', phase: 'running' }, open: 'running' }],
    ['DEAD requester', { requester: 'DEAD', attempt: { workerId: 'worker-r', phase: 'finalizing' }, open: 'finalizing' }],
    ['deregistered requester', { requester: 'absent', attempt: { workerId: 'worker-r', phase: 'finalizing' }, open: 'finalizing' }],
    ["another seat's attempt", { requester: 'live', attempt: { workerId: 'worker-x', phase: 'finalizing' }, open: 'finalizing' }],
    ['malformed record', { requester: 'live', attempt: null, malformedRecord: true, open: 'finalizing' }],
    ['unreadable record', {
      requester: 'live', attempt: { workerId: 'worker-r', phase: 'finalizing' }, unreadable: true, open: 'finalizing',
    }],
  ];

  /** On disk before load: task-r is REVIEW and unassigned (as complete_task leaves it), with a live waiter task-live behind it. */
  function seedDisk(seed: Seed): void {
    h.createTask({ id: 'task-r', status: 'REVIEW', assignedWorkerId: null, order: 2 });
    if (seed.requester !== 'absent') {
      h.createWorker({ id: 'worker-r', status: seed.requester === 'DEAD' ? 'DEAD' : 'IDLE', currentTaskId: null });
    }
    h.createWorker({ id: 'worker-x', status: 'IDLE', currentTaskId: null });
    h.createTask({ id: 'task-live', status: 'WORKING', assignedWorkerId: 'worker-live', order: 3 });
    h.createWorker({ id: 'worker-live', status: 'CODING', currentTaskId: 'task-live' });
    if (seed.malformedRecord) {
      fs.mkdirSync(path.join(h.moePath, 'attempts'), { recursive: true });
      fs.writeFileSync(path.join(h.moePath, 'attempts', 'attempt-bad.json'), JSON.stringify(
        { id: 'attempt-bad', taskId: 'task-r', phase: 'finalizing', generation: 'x' }));
    }
  }

  /** After load, with the store's own functions. Never fake a mismatch by clearing a seat through updateTask: it closes running attempts. */
  async function seedAttempt(seed: Seed): Promise<void> {
    if (!seed.attempt) return;
    const opened = await openAttempt(h.state, {
      taskId: 'task-r', workerId: seed.attempt.workerId, runnerId: 'runner-r', workspace: h.testDir,
    });
    if (seed.attempt.phase !== 'running') await setAttemptPhase(h.state, opened.id, seed.attempt.phase);
  }

  /** The fixture is what the case name says, so the row is passed over for the intended reason and not because a seed silently failed to apply. */
  function expectSeeded(seed: Seed): void {
    expect(currentAttempt(h.state, 'task-r')?.phase ?? null).toBe(seed.open);
    const seat = seed.requester === 'absent' ? undefined : seed.requester === 'DEAD' ? 'DEAD' : 'IDLE';
    expect(h.state.getWorker('worker-r')?.status).toBe(seat);
    if (seed.malformedRecord) {
      expect(currentAttempt(h.state, 'task-r')).toMatchObject({ id: 'attempt-bad' });
      expect(currentAttempt(h.state, 'task-r')?.workerId).toBeUndefined();
    }
  }

  it.each(SEEDS)('passes over a landing row no live seat can use (%s) and grants the live waiter behind it', async (_name, seed) => {
    seedDisk(seed);
    await loadState();
    await seedAttempt(seed);
    expectSeeded(seed);

    await h.state.acquireResource({ resourceId: RID, taskId: 'task-a', workerId: 'worker-a' });
    await h.state.acquireResource({ resourceId: RID, taskId: 'task-r', workerId: 'worker-r' });
    await h.state.acquireResource({ resourceId: RID, taskId: 'task-live', workerId: 'worker-live' });
    const queuedEntry = readResource().queue.find((entry) => entry.taskId === 'task-r');
    expect(queuedEntry).toBeDefined();
    const warn = vi.spyOn(logger, 'warn');
    if (seed.unreadable) {
      vi.spyOn(h.state.attempts, 'values').mockImplementationOnce(() => { throw new Error('unreadable attempt record'); });
    }

    // The release resolves: no seed, however broken, throws out of the grant pass.
    const result = await h.state.releaseResource({ resourceId: RID, workerId: 'worker-a' });

    expect(result.granted.map((lease) => lease.taskId)).toEqual(['task-live']);
    const persisted = readResource();
    expect(persisted.holders.map((lease) => lease.taskId)).toEqual(['task-live']);
    // Passed over, not dropped: the entry keeps its requestedAt and its place.
    expect(persisted.queue).toEqual([queuedEntry]);
    expect(h.state.getTask('task-r')).toMatchObject({ status: 'REVIEW', assignedWorkerId: null });
    // An unreadable record is reported, and only that one.
    const reported = warn.mock.calls.filter(([, message]) => String(message).includes('attempt record unreadable'));
    expect(reported).toHaveLength(seed.unreadable ? 1 : 0);
  });
});
