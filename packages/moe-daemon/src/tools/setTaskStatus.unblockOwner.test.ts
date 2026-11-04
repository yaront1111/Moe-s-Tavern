import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAttempts } from '../state/attemptStore.js';
import { parkedHoldOwner } from '../state/dependencyUnblock.js';
import type { ExecutionAttemptPhase, TaskStatus, Worker } from '../types/schema.js';
import { acquireResourceTool } from './acquireResource.js';
import { claimNextTaskTool } from './claimNextTask.js';
import type { ToolDefinition } from './index.js';
import { reportBlockedTool } from './reportBlocked.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import { ToolTestHarness } from './toolTestHarness.js';

interface OwnerCase {
  name: string;
  from: TaskStatus | null;
  assignee: string | null;
  worker?: Pick<Worker, 'status' | 'currentTaskId'>;
  expected: string | null;
}

describe('set_task_status parked hold ownership', () => {
  const h = new ToolTestHarness();
  const workerId = 'worker-parked';

  beforeEach(() => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 });
    h.createEpic();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);
    vi.spyOn(h.state, 'postToGeneral').mockResolvedValue(undefined);
  });

  afterEach(() => {
    h.state.clearEmitter();
    vi.restoreAllMocks();
    h.cleanup();
  });

  function phases(): Array<[number, ExecutionAttemptPhase]> {
    return listAttempts(h.state, 'task-W').map(a => [a.generation, a.phase]);
  }

  async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await tool.handler(args, h.state) as Record<string, unknown>;
  }

  async function parkOnResource(): Promise<void> {
    h.createTask({ id: 'task-W', status: 'WORKING' });
    h.createTask({ id: 'task-holder', status: 'WORKING', order: 2 });
    await h.state.load();
    const claimed = await call(claimNextTaskTool(h.state), {
      taskId: 'task-W', statuses: ['WORKING'], workerId,
    });
    expect(claimed.generation).toBe(1);
    const held = await call(acquireResourceTool(h.state), {
      resourceId: 'bench-box', taskId: 'task-holder', workerId: 'worker-holder',
    });
    expect(held.granted).toBe(true);
    const parked = await call(reportBlockedTool(h.state), {
      taskId: 'task-W', workerId, resourceId: 'bench-box', reason: 'Waiting for bench-box',
      blockedOnTaskIds: [],
    });
    expect(parked.granted).toBe(false);
    expect(h.state.getTask('task-W')).toMatchObject({
      status: 'BLOCKED', assignedWorkerId: workerId, blockedResourceId: 'bench-box',
      blockedFromStatus: 'WORKING',
    });
    expect(h.state.getWorker(workerId)).toMatchObject({ status: 'BLOCKED', currentTaskId: 'task-W' });
    expect(phases()).toEqual([[1, 'running']]);
  }

  it('releases the timed-out resource corpse and closes its running attempt', async () => {
    await parkOnResource();
    // report_blocked refreshes the seat: age it afterwards, before the real sweep.
    await h.state.updateWorker(workerId, {
      lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    await h.state.checkBlockedTimeouts();
    expect(h.state.getTask('task-W')).toMatchObject({ status: 'BLOCKED', assignedWorkerId: workerId });
    expect(h.state.getWorker(workerId)).toMatchObject({ status: 'IDLE', currentTaskId: null });
    expect(phases()).toEqual([[1, 'running']]);

    // No workerId: the human/manual unblock path.
    await call(setTaskStatusTool(h.state), { taskId: 'task-W', status: 'WORKING' });

    const task = h.state.getTask('task-W')!;
    expect(task.status).toBe('WORKING');
    expect.soft(task.assignedWorkerId).toBeNull();
    expect.soft(h.state.isTaskClaimable(task)).toBe(true);
    expect.soft(phases()).toEqual([[1, 'closed']]);
    expect.soft(h.state.hasActiveTaskAssignment(workerId)).toBe(false);
  });

  it('keeps the genuine resource hold and its running attempt', async () => {
    await parkOnResource();

    await call(setTaskStatusTool(h.state), { taskId: 'task-W', status: 'WORKING' });

    expect(h.state.getTask('task-W')).toMatchObject({ status: 'WORKING', assignedWorkerId: workerId });
    expect(phases()).toEqual([[1, 'running']]);
  });

  const ownerCases: OwnerCase[] = [
    { name: 'ghost', from: 'WORKING', assignee: 'ghost', expected: null },
    { name: 'DEAD', from: 'WORKING', assignee: workerId,
      worker: { status: 'DEAD', currentTaskId: 'task-W' }, expected: null },
    { name: 'repointed', from: 'WORKING', assignee: workerId,
      worker: { status: 'CODING', currentTaskId: 'task-other' }, expected: null },
    { name: 'IDLE unpointed', from: 'WORKING', assignee: workerId,
      worker: { status: 'IDLE', currentTaskId: null }, expected: null },
    { name: 'genuine BLOCKED', from: 'WORKING', assignee: workerId,
      worker: { status: 'BLOCKED', currentTaskId: 'task-W' }, expected: workerId },
    { name: 'IDLE pointing', from: 'WORKING', assignee: workerId,
      worker: { status: 'IDLE', currentTaskId: 'task-W' }, expected: workerId },
    { name: 'REVIEW ghost', from: 'REVIEW', assignee: 'ghost', expected: null },
    { name: 'PLANNING ghost', from: 'PLANNING', assignee: 'ghost', expected: null },
    { name: 'missing restore target', from: null, assignee: 'ghost', expected: null },
    { name: 'unassigned', from: 'WORKING', assignee: null, expected: null },
  ];

  it.each(ownerCases)('restores only a genuine owner: $name', async ({ from, assignee, worker, expected }) => {
    h.createTask({
      id: 'task-W', status: 'BLOCKED', blockedFromStatus: from, assignedWorkerId: assignee,
    });
    if (worker) h.createWorker({ id: workerId, ...worker });
    await h.state.load();
    expect(parkedHoldOwner(h.state, h.state.getTask('task-W')!)).toBe(expected);

    await call(setTaskStatusTool(h.state), { taskId: 'task-W', status: from ?? 'WORKING' });

    expect(h.state.getTask('task-W')?.status).toBe(from ?? 'WORKING');
    expect(h.state.getTask('task-W')?.assignedWorkerId).toBe(expected);
  });
});
