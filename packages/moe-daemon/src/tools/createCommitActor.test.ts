// task-c05bf92d: create_task's TASK_CREATED and record_commit's normal-branch
// TASK_COMMIT_RECORDED name the calling seat as the event's top-level workerId,
// the field get_activity_log { workerId } filters on. Modeled on
// tools/taskEventActor.test.ts (mem:gotcha-task-event-actor-inventory).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { ToolTestHarness } from './toolTestHarness.js';
import { MoeWebSocketServer } from '../server/WebSocketServer.js';
import { McpAdapter } from '../server/McpAdapter.js';
import { flushActivityLog } from '../state/activityLog.js';
import { createTaskTool } from './createTask.js';
import { recordCommitTool, resetRecordCommitGovernorRateLimit } from './recordCommit.js';
import { getActivityLogTool } from './getActivityLog.js';
import type { ActivityEvent, Task } from '../types/schema.js';

describe('create_task and record_commit actor attribution', () => {
  const h = new ToolTestHarness();
  const actorEvents = ['TASK_CREATED', 'TASK_COMMIT_RECORDED'];
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const landing = (taskId: string, extra: Record<string, unknown>) => ({
    taskId, kind: 'completion', role: 'worker', sessionId: 'worker-1@2026-11-03T10:00:00.000Z',
    sha, ref: 'moe/work-2026-10-24', status: 'REVIEW', pushed: true, ...extra,
  });

  beforeEach(async () => {
    h.init();
    resetRecordCommitGovernorRateLimit();
    h.setupMoeFolder();
    h.createEpic();
    for (const id of ['task-done', 'task-none', 'task-guard', 'task-anon']) {
      h.createTask({ id, title: id, status: 'REVIEW', assignedWorkerId: 'qa-1' });
    }
    await h.state.load();
  });

  afterEach(async () => {
    await flushActivityLog(h.state);
    h.cleanup();
  });

  function actorsOf(event: string, taskId: string): Array<string | null> {
    return h.state.getActivityLog(200)
      .filter((e) => e.event === event && e.taskId === taskId)
      .map((e) => e.workerId ?? null);
  }

  async function seatEvents(workerId: string): Promise<string[]> {
    const result = await getActivityLogTool(h.state).handler({ workerId, limit: 100 }, h.state) as { events: ActivityEvent[] };
    return result.events.filter((e) => actorEvents.includes(e.event)).map((e) => `${e.event} ${e.taskId}`).sort();
  }

  it('(z1) records the calling seat on TASK_CREATED and on each normal-branch TASK_COMMIT_RECORDED', async () => {
    const filed = await createTaskTool(h.state).handler(
      { epicId: 'epic-1', title: 'Filed by a seat', workerId: 'governor-g1' }, h.state,
    ) as { success: boolean; task: Task };
    expect(filed).toMatchObject({ success: true, task: { createdBy: 'GOVERNOR' } });
    await expect(recordCommitTool(h.state).handler(landing('task-done', { outcome: 'committed', workerId: 'worker-1' }), h.state))
      .resolves.toMatchObject({ success: true, outcome: 'committed', duplicate: false });
    await expect(recordCommitTool(h.state).handler({
      taskId: 'task-none', outcome: 'nothing', kind: 'checkpoint', role: 'worker',
      sessionId: 'worker-2@2026-11-03T10:00:00.000Z', workerId: 'worker-2',
    }, h.state)).resolves.toMatchObject({ success: true, outcome: 'nothing' });
    await expect(recordCommitTool(h.state).handler(
      landing('task-guard', { outcome: 'refused', code: 'MOE_COMMIT_REFUSED_ACTIVE_ASSIGNEE', workerId: 'worker-3' }), h.state,
    )).resolves.toMatchObject({ success: true, outcome: 'refused' });
    await flushActivityLog(h.state);

    expect.soft(actorsOf('TASK_CREATED', filed.task.id), 'create_task TASK_CREATED actor').toEqual(['governor-g1']);
    expect.soft(actorsOf('TASK_COMMIT_RECORDED', 'task-done'), 'committed TASK_COMMIT_RECORDED actor').toEqual(['worker-1']);
    expect.soft(actorsOf('TASK_COMMIT_RECORDED', 'task-none'), 'nothing TASK_COMMIT_RECORDED actor').toEqual(['worker-2']);
    expect.soft(actorsOf('TASK_COMMIT_RECORDED', 'task-guard'), 'owner-guard TASK_COMMIT_RECORDED actor').toEqual(['worker-3']);
    expect.soft(h.state.getTask('task-done')?.commits?.map((c) => c.recordedBy), 'recordedBy').toEqual(['worker-1']);
    const seats: Array<[string, string[]]> = [
      ['governor-g1', [`TASK_CREATED ${filed.task.id}`]],
      ['worker-1', ['TASK_COMMIT_RECORDED task-done']],
      ['worker-2', ['TASK_COMMIT_RECORDED task-none']],
      ['worker-3', ['TASK_COMMIT_RECORDED task-guard']],
    ];
    for (const [seat, expected] of seats) {
      expect.soft(await seatEvents(seat), `get_activity_log { workerId: ${seat} }`).toEqual(expected);
    }
  });

  it('(z2) records no actor for a caller-less create_task and a caller-less record_commit', async () => {
    const anon = await createTaskTool(h.state).handler({ epicId: 'epic-1', title: 'Filed with no seat id' }, h.state) as {
      success: boolean; task: Task;
    };
    expect(anon).toMatchObject({ success: true, task: { createdBy: 'WORKER' } });
    await expect(recordCommitTool(h.state).handler(landing('task-anon', { outcome: 'committed' }), h.state))
      .resolves.toMatchObject({ success: true, outcome: 'committed' });
    await flushActivityLog(h.state);

    expect.soft(actorsOf('TASK_CREATED', anon.task.id), 'caller-less create_task actor').toEqual([null]);
    expect.soft(actorsOf('TASK_COMMIT_RECORDED', 'task-anon'), 'caller-less record_commit actor').toEqual([null]);
    expect.soft(h.state.getTask('task-anon')?.commits?.map((c) => c.recordedBy), 'caller-less recordedBy').toEqual(['unknown']);
    for (const seat of ['unknown', 'WORKER']) {
      expect.soft(await seatEvents(seat), `get_activity_log { workerId: ${seat} }`).toEqual([]);
    }
  });

  it('(z3) records no actor for the board CREATE_TASK over /ws, even when its payload names a seat', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const wsServer = new MoeWebSocketServer(server, h.state, new McpAdapter(h.state));
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
    try {
      const reply = new Promise<{ type: string; payload?: Task; message?: string }>((resolve) => {
        socket.on('message', (data) => {
          const frame = JSON.parse(data.toString()) as { type: string; payload?: Task; message?: string };
          if (frame.type === 'TASK_CREATED' || frame.type === 'ERROR') resolve(frame);
        });
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      // WebSocketServer.ts CREATE_TASK hands this raw payload to state.createTask as its only argument.
      socket.send(JSON.stringify({ type: 'CREATE_TASK', payload: {
        epicId: 'epic-1', title: 'Board row', workerId: 'smuggled-seat', actorWorkerId: 'smuggled-seat',
      } }));
      const frame = await reply;
      expect(frame).toMatchObject({ type: 'TASK_CREATED', payload: { title: 'Board row' } });
      await flushActivityLog(h.state);

      expect.soft(actorsOf('TASK_CREATED', frame.payload!.id), 'board /ws create actor').toEqual([null]);
      expect.soft(await seatEvents('smuggled-seat'), 'get_activity_log { workerId: smuggled-seat }').toEqual([]);
    } finally {
      socket.close();
      await wsServer.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
