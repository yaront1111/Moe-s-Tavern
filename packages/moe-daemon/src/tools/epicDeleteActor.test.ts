// task-3e1d0c2e: create_epic, update_epic, delete_epic and delete_task name the
// calling seat as the event's top-level workerId, the field
// get_activity_log { workerId } filters on (mem:gotcha-task-event-actor-inventory).
// Ported from the hunt repro /mnt/d/moe-scratch/hunt-44785c82/A/epicDeleteActor.test.ts.
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { createTaskTool } from './createTask.js';
import { createEpicTool } from './createEpic.js';
import { updateEpicTool } from './updateEpic.js';
import { deleteEpicTool } from './deleteEpic.js';
import { deleteTaskTool } from './deleteTask.js';
import { getActivityLogTool } from './getActivityLog.js';
import type { ActivityEvent, Epic } from '../types/schema.js';

const OWN = ['EPIC_CREATED', 'EPIC_UPDATED', 'EPIC_DELETED', 'TASK_CREATED', 'TASK_DELETED'];

describe('epic tools and delete_task record the caller as actor', () => {
  const h = new ToolTestHarness();
  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic({ id: 'epic-1' });
    h.createEpic({ id: 'epic-2', title: 'Cascade epic', order: 2 });
    h.createTask({ id: 'task-victim', status: 'BACKLOG' });
    h.createTask({ id: 'task-cascaded', epicId: 'epic-2', status: 'BACKLOG' });
    await h.state.load();
  });
  afterEach(async () => { await flushActivityLog(h.state); h.cleanup(); });

  const events = (event: string) => h.state.getActivityLog(500).filter((e) => e.event === event);
  async function seat(workerId: string): Promise<string[]> {
    const r = await getActivityLogTool(h.state).handler({ workerId, limit: 100 }, h.state) as { events: ActivityEvent[] };
    return r.events.filter((e) => OWN.includes(e.event)).map((e) => e.event).sort();
  }

  it('(a1) get_activity_log { workerId } returns the seat\'s create, update and delete events', async () => {
    const actor = 'architect-c';
    await createTaskTool(h.state).handler({ epicId: 'epic-1', title: 'baseline row', workerId: actor }, h.state);
    const { epic } = await createEpicTool(h.state).handler({ title: 'New epic', workerId: actor }, h.state) as { epic: Epic };
    await updateEpicTool(h.state).handler({ epicId: epic.id, title: 'Renamed', workerId: actor }, h.state);
    expect.soft(h.state.getEpic(epic.id), 'epic in memory').not.toHaveProperty('workerId');
    const onDisk = JSON.parse(fs.readFileSync(path.join(h.moePath, 'epics', `${epic.id}.json`), 'utf8')) as object;
    expect.soft(onDisk, 'epic on disk').not.toHaveProperty('workerId');
    await deleteEpicTool(h.state).handler({ epicId: epic.id, workerId: actor }, h.state);
    await deleteTaskTool(h.state).handler({ taskId: 'task-victim', workerId: actor }, h.state);
    await flushActivityLog(h.state);

    expect.soft(events('EPIC_UPDATED').map((e) => e.payload.changedFields), 'changedFields').toEqual([['title']]);
    expect.soft(events('EPIC_DELETED').map((e) => e.payload), 'EPIC_DELETED payload').toEqual([{ title: 'Renamed' }]);
    expect.soft(events('TASK_DELETED').map((e) => [e.taskId, e.payload]), 'TASK_DELETED').toEqual([['task-victim', { title: 'Test Task' }]]);
    expect(await seat(actor)).toEqual(['EPIC_CREATED', 'EPIC_DELETED', 'EPIC_UPDATED', 'TASK_CREATED', 'TASK_DELETED']);
  });

  it('(a2) a delete_epic cascade records the caller on each TASK_DELETED and on EPIC_DELETED', async () => {
    await deleteEpicTool(h.state).handler({ epicId: 'epic-2', cascadeDelete: true, workerId: 'governor-g' }, h.state);
    await flushActivityLog(h.state);
    expect.soft(events('TASK_DELETED').map((e) => [e.taskId, e.workerId]), 'cascade TASK_DELETED').toEqual([['task-cascaded', 'governor-g']]);
    expect.soft(events('EPIC_DELETED').map((e) => e.workerId), 'EPIC_DELETED actor').toEqual(['governor-g']);
    expect(await seat('governor-g')).toEqual(['EPIC_DELETED', 'TASK_DELETED']);
  });

  it('(a3) update_epic still refuses an unknown field when workerId is present', async () => {
    const before = structuredClone(h.state.getEpic('epic-1'));
    await expect(updateEpicTool(h.state).handler({ epicId: 'epic-1', title: 'X', bogus: 1, workerId: 'architect-c' }, h.state))
      .rejects.toThrow(/bogus/);
    expect(h.state.getEpic('epic-1')).toEqual(before);
    await flushActivityLog(h.state);
    expect(events('EPIC_UPDATED')).toEqual([]);
  });

  it('(a4) a caller-less call succeeds and records no actor', async () => {
    const { epic } = await createEpicTool(h.state).handler({ title: 'Anon epic' }, h.state) as { epic: Epic };
    await updateEpicTool(h.state).handler({ epicId: epic.id, title: 'Anon renamed' }, h.state);
    await deleteEpicTool(h.state).handler({ epicId: epic.id }, h.state);
    await deleteTaskTool(h.state).handler({ taskId: 'task-victim' }, h.state);
    // WebSocketServer's CREATE_EPIC hands its raw /ws payload to state.createEpic as the only argument.
    const board = await h.state.createEpic({ title: 'Board epic', workerId: 'smuggled-seat' } as unknown as Partial<Epic>);
    await flushActivityLog(h.state);
    expect.soft(events('EPIC_CREATED').map((e) => e.workerId ?? null), 'EPIC_CREATED actors').toEqual([null, null]);
    for (const ev of ['EPIC_UPDATED', 'EPIC_DELETED', 'TASK_DELETED']) {
      expect.soft(events(ev).map((e) => e.workerId ?? null), `${ev} actor`).toEqual([null]);
    }
    expect.soft(board, 'board epic').not.toHaveProperty('workerId');
    for (const s of ['unknown', 'agent', 'smuggled-seat']) expect.soft(await seat(s), s).toEqual([]);
  });
});
