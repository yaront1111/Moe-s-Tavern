import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { archiveEpicTool } from './archiveEpic.js';
import { getActivityLogTool } from './getActivityLog.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import type { ActivityEvent } from '../types/schema.js';

describe('moe.archive_epic', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    await h.state.load();
  });

  it('archives the epic and all its resting tickets', async () => {
    h.createTask({ id: 'task-1', status: 'DONE' });
    h.createTask({ id: 'task-2', status: 'BACKLOG' });
    await h.state.load();
    const tool = archiveEpicTool(h.state);
    const result = await tool.handler({ epicId: 'epic-1' }, h.state) as {
      success: boolean; epicStatus: string; archivedTaskCount: number; totalTasks: number;
    };
    expect(result.success).toBe(true);
    expect(result.epicStatus).toBe('ARCHIVED');
    expect(result.archivedTaskCount).toBe(2);
    expect(result.totalTasks).toBe(2);
    expect(h.state.getEpic('epic-1')!.status).toBe('ARCHIVED');
    expect(h.state.getTask('task-1')!.status).toBe('ARCHIVED');
    expect(h.state.getTask('task-2')!.status).toBe('ARCHIVED');
  });

  it('clears a BLOCKED row\'s block fields exactly as archive_task does; un-archiving carries none of them', async () => {
    h.createEpic({ id: 'epic-2' });
    h.createTask({ id: 'task-dep', epicId: 'epic-2', status: 'WORKING' });
    h.createTask({ id: 'task-done', status: 'DONE' });
    h.createTask({
      id: 'task-bk', status: 'BLOCKED', blockedReason: 'needs PostgreSQL', blockedResourceId: 'pg-box',
      blockedOnTaskIds: ['task-dep'], blockedFromStatus: 'WORKING', blockedAt: '2026-09-05T22:22:00.000Z',
    });
    await h.state.load();
    const result = await archiveEpicTool(h.state).handler({ epicId: 'epic-1' }, h.state) as { archivedTaskCount: number };
    expect(result.archivedTaskCount).toBe(2);
    expect(h.state.getTask('task-bk')).toMatchObject({
      status: 'ARCHIVED', priorBlockedReason: 'needs PostgreSQL', blockedReason: null,
      blockedResourceId: null, blockedOnTaskIds: null, blockedFromStatus: null, blockedAt: null,
    });
    const done = h.state.getTask('task-done')!;
    expect(done.status).toBe('ARCHIVED');
    expect(done.priorBlockedReason ?? null).toBeNull();
    await setTaskStatusTool(h.state).handler({ taskId: 'task-bk', status: 'WORKING' }, h.state);
    expect(h.state.getTask('task-bk')).toMatchObject({ status: 'WORKING', blockedOnTaskIds: null, blockedFromStatus: null });
  });

  it('still archives a held BLOCKED row for a caller-less call, its holder, or any caller when the row is unassigned', async () => {
    const blocked = { status: 'BLOCKED', blockedReason: 'waiting on bench-box', blockedFromStatus: 'WORKING' } as const;
    h.createEpic({ id: 'epic-hu', order: 2 });
    h.createEpic({ id: 'epic-ho', order: 3 });
    h.createEpic({ id: 'epic-un', order: 4 });
    h.createTask({ id: 'task-hu', epicId: 'epic-hu', assignedWorkerId: 'worker-x', blockedResourceId: 'bench-box', ...blocked });
    h.createWorker({ id: 'worker-x', epicId: 'epic-hu', currentTaskId: 'task-hu', status: 'BLOCKED' });
    h.createTask({ id: 'task-ho', epicId: 'epic-ho', assignedWorkerId: 'worker-y', ...blocked });
    h.createWorker({ id: 'worker-y', epicId: 'epic-ho', currentTaskId: 'task-ho', status: 'BLOCKED' });
    h.createTask({ id: 'task-un', epicId: 'epic-un', assignedWorkerId: null, ...blocked });
    await h.state.load();

    const tool = archiveEpicTool(h.state);
    const results = [
      await tool.handler({ epicId: 'epic-hu' }, h.state), // a human: no workerId
      await tool.handler({ epicId: 'epic-ho', workerId: 'worker-y' }, h.state), // the holder itself
      await tool.handler({ epicId: 'epic-un', workerId: 'architect-c' }, h.state), // nobody holds the row
    ];
    expect(results).toEqual(['epic-hu', 'epic-ho', 'epic-un'].map((epicId) => ({
      success: true, epicId, epicStatus: 'ARCHIVED', archivedTaskCount: 1, totalTasks: 1,
    })));
    for (const id of ['task-hu', 'task-ho', 'task-un']) expect(h.state.getTask(id)?.status).toBe('ARCHIVED');

    // The actor is the bare caller; a caller-less call records none (never a placeholder).
    await flushActivityLog(h.state);
    const ids = ['task-hu', 'task-ho', 'task-un'];
    const actors = Object.fromEntries(h.state.getActivityLog(200)
      .filter((e: ActivityEvent) => e.event === 'TASK_ARCHIVED' && ids.includes(e.taskId ?? ''))
      .map((e: ActivityEvent) => [e.taskId, e.workerId ?? null]));
    expect(actors).toEqual({ 'task-hu': null, 'task-ho': 'worker-y', 'task-un': 'architect-c' });

    // updateTask clears the assignee in the same write, so the caller-less row reads "by unknown".
    const general = h.state.getChannels().find((c) => c.name === 'general');
    const file = general ? path.join(h.moePath, 'messages', `${general.id}.jsonl`) : '';
    const lines = file && fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map((l) => (JSON.parse(l) as { content: string }).content)
        .filter((c) => c.includes('Task moved to') && ids.some((id) => c.startsWith(`${id}:`)))
      : [];
    expect([...lines].sort()).toEqual([
      'task-ho: Task moved to ARCHIVED by worker-y',
      'task-hu: Task moved to ARCHIVED by unknown',
      'task-un: Task moved to ARCHIVED by architect-c',
    ]);
  });

  it('(e1) records the caller on the epic\'s EPIC_UPDATED as on each TASK_ARCHIVED; a caller-less archive and an idempotent re-archive record none', async () => {
    h.createEpic({ id: 'epic-ac', order: 2 });
    h.createEpic({ id: 'epic-nc', order: 3 });
    h.createTask({ id: 'task-ac1', epicId: 'epic-ac', status: 'DONE' });
    h.createTask({ id: 'task-ac2', epicId: 'epic-ac', status: 'BACKLOG', order: 2 });
    h.createTask({ id: 'task-nc', epicId: 'epic-nc', status: 'DONE' });
    await h.state.load();

    const tool = archiveEpicTool(h.state);
    await tool.handler({ epicId: 'epic-ac', workerId: 'architect-c' }, h.state);
    await tool.handler({ epicId: 'epic-nc' }, h.state); // a human: no workerId
    // Already ARCHIVED: nothing is written, so nothing is attributed to this caller.
    expect(await tool.handler({ epicId: 'epic-ac', workerId: 'worker-z' }, h.state)).toEqual({
      success: true, epicId: 'epic-ac', epicStatus: 'ARCHIVED', archivedTaskCount: 0, totalTasks: 2,
    });
    await flushActivityLog(h.state);

    const kinds = ['EPIC_UPDATED', 'TASK_ARCHIVED'];
    const key = (e: ActivityEvent) => `${e.event}:${e.taskId ?? e.epicId}`;
    // get_activity_log { workerId } filters on the event's top-level workerId alone.
    const seats: Record<string, string[]> = {};
    for (const workerId of ['architect-c', 'worker-z', 'unknown', 'agent']) {
      const { events } = await getActivityLogTool(h.state).handler({ workerId, limit: 100 }, h.state) as { events: ActivityEvent[] };
      seats[workerId] = events.filter((e) => kinds.includes(e.event)).map(key).sort();
    }
    expect.soft(seats).toEqual({
      'architect-c': ['EPIC_UPDATED:epic-ac', 'TASK_ARCHIVED:task-ac1', 'TASK_ARCHIVED:task-ac2'],
      'worker-z': [], unknown: [], agent: [],
    });

    // Every archive event of both epics, once each: the bare caller, or null for a caller-less call (never a placeholder).
    const events = h.state.getActivityLog(200)
      .filter((e: ActivityEvent) => kinds.includes(e.event) && ['epic-ac', 'epic-nc'].includes(e.epicId ?? ''));
    expect.soft(events.map((e) => [key(e), e.workerId ?? null]).sort()).toEqual([
      ['EPIC_UPDATED:epic-ac', 'architect-c'], ['EPIC_UPDATED:epic-nc', null],
      ['TASK_ARCHIVED:task-ac1', 'architect-c'], ['TASK_ARCHIVED:task-ac2', 'architect-c'], ['TASK_ARCHIVED:task-nc', null],
    ]);
    // Both EPIC_UPDATED events are the status -> ARCHIVED write, payload unchanged.
    expect.soft(Object.fromEntries(events.filter((e) => e.event === 'EPIC_UPDATED').map((e) => [e.epicId, e.payload]))).toEqual({
      'epic-ac': { epicId: 'epic-ac', changedFields: ['status'], status: 'ARCHIVED' },
      'epic-nc': { epicId: 'epic-nc', changedFields: ['status'], status: 'ARCHIVED' },
    });
  });

  it('refuses when the epic has an in-flight ticket', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();
    const tool = archiveEpicTool(h.state);
    await expect(tool.handler({ epicId: 'epic-1' }, h.state)).rejects.toThrow();
    // nothing changed
    expect(h.state.getEpic('epic-1')!.status).not.toBe('ARCHIVED');
  });

  it('archives an empty epic', async () => {
    const tool = archiveEpicTool(h.state);
    const result = await tool.handler({ epicId: 'epic-1' }, h.state) as { archivedTaskCount: number; epicStatus: string };
    expect(result.archivedTaskCount).toBe(0);
    expect(result.epicStatus).toBe('ARCHIVED');
  });

  it('throws for an unknown epic', async () => {
    const tool = archiveEpicTool(h.state);
    await expect(tool.handler({ epicId: 'nope' }, h.state)).rejects.toThrow();
  });
});

