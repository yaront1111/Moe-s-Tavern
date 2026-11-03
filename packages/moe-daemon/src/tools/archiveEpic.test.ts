import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { archiveEpicTool } from './archiveEpic.js';
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

