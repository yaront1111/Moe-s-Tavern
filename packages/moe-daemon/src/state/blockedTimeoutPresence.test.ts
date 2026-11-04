import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { StateManager } from './StateManager.js';
import { isWorkerAlive } from '../util/workerLiveness.js';

// The blocked-timeout sweep times a silent BLOCKED seat out as a corpse. Its IDLE write must keep the
// seat's real lastActivityAt, as the REVIEW self-heal and the reconcile-window sweep in sweeps.ts do.
// A fresh stamp makes the corpse read alive for the presence window, lets a daemon restart in that
// window spare it, and defers the same pass's Layer-3 prune by a full staleWorkerTimeoutMs.
describe('blocked-timeout keeps a timed-out seat silent', () => {
  const h = new ToolTestHarness();
  const HOUR = 60 * 60 * 1000;
  // Silent past blockedTimeoutMs (1 h) and staleWorkerTimeoutMs (3 h): timed out, then pruned.
  const prunedId = 'worker-pruned';
  const prunedLast = new Date(Date.now() - 4 * HOUR).toISOString();
  // Silent past blockedTimeoutMs only: timed out, then kept by the prune (inside its 3 h window).
  const keptId = 'worker-kept';
  const keptLast = new Date(Date.now() - 2 * HOUR).toISOString();

  beforeEach(async () => {
    h.init();
    // Explicit timeouts, so no project.json setting can move either line.
    h.state = new StateManager({ projectPath: h.testDir, blockedTimeoutMs: HOUR, staleWorkerTimeoutMs: 3 * HOUR });
    h.setupMoeFolder();
    h.createEpic();
    // A third-party block on an assigned WORKING row keeps each seat parked BLOCKED.
    for (const seat of [
      { taskId: 'task-1', workerId: prunedId, last: prunedLast },
      { taskId: 'task-2', workerId: keptId, last: keptLast },
    ]) {
      h.createTask({
        id: seat.taskId, status: 'BLOCKED', assignedWorkerId: seat.workerId, blockedFromStatus: 'WORKING',
        blockedReason: 'staging DB is down', blockedAt: seat.last,
      });
      h.createWorker({ id: seat.workerId, status: 'BLOCKED', currentTaskId: seat.taskId, lastActivityAt: seat.last });
    }
    await h.state.load();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);
    vi.spyOn(h.state, 'postToGeneral').mockResolvedValue(undefined);
  });

  afterEach(() => {
    h.state.clearEmitter();
    vi.restoreAllMocks();
    h.cleanup();
  });

  it('keeps the real lastActivityAt, so the seat never reads alive, and the same pass prunes the one that owns nothing', async () => {
    await h.state.checkBlockedTimeouts();

    // The documented park is unchanged: both rows go to BACKLOG, unassigned.
    expect(h.state.getTask('task-1')).toMatchObject({ status: 'BACKLOG', assignedWorkerId: null });
    expect(h.state.getTask('task-2')).toMatchObject({ status: 'BACKLOG', assignedWorkerId: null });

    const kept = h.state.getWorker(keptId);
    expect(kept).toMatchObject({ status: 'IDLE', currentTaskId: null, lastError: null, lastActivityAt: keptLast });
    expect(isWorkerAlive(kept!)).toBe(false);

    // It owns nothing and is silent past staleWorkerTimeoutMs, so Layer 3 of the same pass removes it.
    expect(h.state.getWorker(prunedId)).toBeNull();

    // The WORKER_TIMEOUT event stays, and it records the preserved stamp.
    await h.state.flushActivityLog();
    const timeout = h.state.getActivityLog(100)
      .find((entry) => entry.event === 'WORKER_TIMEOUT' && entry.workerId === keptId && entry.taskId === undefined);
    expect(timeout?.payload).toMatchObject({ status: 'IDLE', currentTaskId: null, lastActivityAt: keptLast });
  });

  it('a daemon restart right after the timeout does not spare the timed-out seat', async () => {
    await h.state.checkBlockedTimeouts();
    expect(h.state.getWorker(keptId)).not.toBeNull();

    await h.state.purgeAllWorkers();

    expect(h.state.getWorker(keptId)).toBeNull();
  });
});
