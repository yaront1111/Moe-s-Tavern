// What deleteTask cleans up besides the row: the delivery records it owned, the
// BLOCKED consumers waiting on it, the leases and queue entries it held, and a
// task file Windows briefly refuses to unlink.

import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';

describe('deleteTask cleanup', () => {
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

  async function loadState(): Promise<void> {
    await h.state.load();
    vi.spyOn(h.state, 'postToGeneral').mockResolvedValue();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue();
    vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue();
  }

  function writeRecord(kind: string, record: { id: string } & Record<string, unknown>): string {
    const dir = path.join(h.moePath, kind);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${record.id}.json`);
    fs.writeFileSync(file, JSON.stringify(record));
    return file;
  }

  /** One task's delivery trail: an attempt, a candidate, its check run and receipt, and a review. */
  function seedTrail(taskId: string, n: number): Record<string, string> {
    const createdAt = new Date().toISOString();
    return {
      attempt: writeRecord('attempts', { id: `attempt-${n}`, taskId, phase: 'closed', createdAt }),
      candidate: writeRecord('candidates', { id: `candidate-${n}`, taskId, attemptId: `attempt-${n}`, createdAt }),
      check: writeRecord('checks', { id: `check-${n}`, candidateId: `candidate-${n}`, createdAt }),
      receipt: writeRecord('receipts', { id: `receipt-${n}`, candidateId: `candidate-${n}`, createdAt }),
      review: writeRecord('reviews', { id: `review-${n}`, taskId, candidateId: `candidate-${n}`, createdAt }),
    };
  }

  function held(n: number): Record<string, boolean> {
    return {
      attempt: h.state.attempts.has(`attempt-${n}`),
      candidate: h.state.candidates.has(`candidate-${n}`),
      check: h.state.checkRuns.has(`check-${n}`),
      receipt: h.state.receipts.has(`receipt-${n}`),
      review: h.state.reviews.has(`review-${n}`),
    };
  }

  it('drops the deleted task\'s candidates, check runs, receipts and reviews, keeps its closed attempts and every other task\'s trail', async () => {
    h.createTask({ id: 'task-D', status: 'BACKLOG' });
    h.createTask({ id: 'task-K', status: 'DONE' });
    const gone = seedTrail('task-D', 1);
    const kept = seedTrail('task-K', 2);
    await loadState();

    await h.state.deleteTask('task-D');
    await h.state.updateTask('task-K', { status: 'ARCHIVED' });

    const dropped = { attempt: true, candidate: false, check: false, receipt: false, review: false };
    const all = { attempt: true, candidate: true, check: true, receipt: true, review: true };
    expect(held(1)).toEqual(dropped);
    expect(held(2)).toEqual(all);
    expect(Object.fromEntries(Object.entries(gone).map(([kind, file]) => [kind, fs.existsSync(file)]))).toEqual(dropped);
    expect(Object.values(kept).every((file) => fs.existsSync(file))).toBe(true);

    await h.state.load();
    expect(held(1)).toEqual(dropped);
    expect(held(2)).toEqual(all);
  });

  it('un-blocks a consumer BLOCKED on the deleted task at once, not at the next sweep', async () => {
    h.createTask({ id: 'task-P', status: 'WORKING' });
    h.createTask({
      id: 'task-C',
      status: 'BLOCKED',
      blockedOnTaskIds: ['task-P'],
      blockedFromStatus: 'WORKING',
      blockedReason: 'waiting on task-P',
      blockedAt: new Date().toISOString(),
    });
    await loadState();

    await h.state.deleteTask('task-P');

    expect(h.state.getTask('task-C')).toMatchObject({ status: 'WORKING', blockedOnTaskIds: null, blockedReason: null });
    expect(h.state.postToGeneral).toHaveBeenCalledWith(expect.stringContaining('(task-P deleted)'));
  });

  it('grants the deleted holder\'s lease to the next waiter and drops the deleted waiter\'s queue entry', async () => {
    h.createTask({ id: 'task-H', status: 'WORKING', assignedWorkerId: 'worker-h' });
    h.createTask({ id: 'task-W', status: 'WORKING', assignedWorkerId: 'worker-w' });
    h.createTask({ id: 'task-Q', status: 'WORKING', assignedWorkerId: 'worker-q' });
    h.createWorker({ id: 'worker-h', status: 'CODING', currentTaskId: 'task-H' });
    h.createWorker({ id: 'worker-w', status: 'CODING', currentTaskId: 'task-W' });
    h.createWorker({ id: 'worker-q', status: 'CODING', currentTaskId: 'task-Q' });
    await loadState();
    await h.state.acquireResource({ resourceId: 'box', taskId: 'task-H', workerId: 'worker-h' });
    await h.state.acquireResource({ resourceId: 'box', taskId: 'task-Q', workerId: 'worker-q' });
    await h.state.acquireResource({ resourceId: 'box', taskId: 'task-W', workerId: 'worker-w' });

    await h.state.deleteTask('task-Q');
    expect(h.state.getResource('box')!.queue.map((entry) => entry.taskId)).toEqual(['task-W']);

    await h.state.deleteTask('task-H');
    const box = h.state.getResource('box')!;
    expect(box.holders.map((lease) => lease.taskId)).toEqual(['task-W']);
    expect(box.queue).toEqual([]);
  });

  it('retries a task file Windows briefly refuses to unlink', async () => {
    h.createTask({ id: 'task-D', status: 'BACKLOG' });
    await loadState();
    const file = path.join(h.moePath, 'tasks', 'task-D.json');
    const realUnlink = fs.unlinkSync;
    let refusals = 0;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (target === file && refusals < 2) {
        refusals++;
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return realUnlink(target);
    });

    await h.state.deleteTask('task-D');

    expect(refusals).toBe(2);
    expect(fs.existsSync(file)).toBe(false);
    expect(h.state.getTask('task-D')).toBeNull();
  });

  it('keeps the row, on disk and in memory, when the task file never unlinks', async () => {
    h.createTask({ id: 'task-D', status: 'BACKLOG' });
    await loadState();
    const file = path.join(h.moePath, 'tasks', 'task-D.json');
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (target === file) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return realUnlink(target);
    });

    await expect(h.state.deleteTask('task-D')).rejects.toThrow('EPERM');

    expect(fs.existsSync(file)).toBe(true);
    expect(h.state.getTask('task-D')).toMatchObject({ id: 'task-D' });
  });
});
