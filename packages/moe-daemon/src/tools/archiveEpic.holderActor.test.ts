import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { archiveTaskTool } from './archiveTask.js';
import { archiveEpicTool } from './archiveEpic.js';
import type { MoeError } from '../util/errors.js';
import type { ActivityEvent } from '../types/schema.js';

// Family gap: archive_task refuses a held BLOCKED row to any caller but its
// holder (archiveTask.ts HOLDER_ONLY_FROM) and records the caller as the
// TASK_ARCHIVED actor (2e3012b9). archive_epic archives the same rows through
// the same archiveUpdates() but takes no workerId, so it skips both.
describe('archive_epic vs archive_task: holder-only refusal and actor', () => {
  const h = new ToolTestHarness();
  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic({ id: 'epic-held' });
    h.createEpic({ id: 'epic-plain', order: 2 });
    // A resource block keeps the seat parked: BLOCKED, still assigned.
    h.createTask({
      id: 'task-held', epicId: 'epic-held', status: 'BLOCKED', assignedWorkerId: 'worker-x',
      blockedReason: 'waiting on bench-box', blockedResourceId: 'bench-box', blockedFromStatus: 'WORKING',
    });
    // A resting sibling: a holder check raised inside the write loop would
    // archive it before reaching task-held.
    h.createTask({ id: 'task-rest', epicId: 'epic-held', status: 'DONE', order: 2 });
    h.createWorker({ id: 'worker-x', epicId: 'epic-held', currentTaskId: 'task-held', status: 'BLOCKED' });
    h.createTask({ id: 'task-done', epicId: 'epic-plain', status: 'DONE' });
    await h.state.load();
  });
  afterEach(async () => { await flushActivityLog(h.state); h.cleanup(); });

  it('archive_task refuses the held BLOCKED row to a non-holder (sibling baseline)', async () => {
    await expect(archiveTaskTool(h.state).handler({ taskId: 'task-held', workerId: 'architect-c' }, h.state))
      .rejects.toThrow(/held by worker-x/);
  });

  it('archive_epic applies the same holder-only refusal to the same caller', async () => {
    // state.tasks iterates in load (readdir) order. Put the held row LAST, so a
    // refusal raised only when the write loop reached it would find task-rest
    // already archived (the attemptHandback.test.ts archive_epic precedent).
    const held = h.state.tasks.get('task-held')!;
    h.state.tasks.delete('task-held');
    h.state.tasks.set('task-held', held);

    const result = await archiveEpicTool(h.state)
      .handler({ epicId: 'epic-held', workerId: 'architect-c' }, h.state)
      .then((r) => ({ outcome: 'resolved', r }),
        (e: MoeError) => ({ outcome: 'rejected', codeName: e.codeName, message: e.message }));
    expect(result).toMatchObject({ outcome: 'rejected', codeName: 'NOT_ALLOWED' });
    expect((result as { message: string }).message).toContain('task-held');
    expect((result as { message: string }).message).toContain('worker-x');

    // All-or-nothing: no task or epic write, and archiveUpdates never ran on the held row.
    expect(h.state.getTask('task-held')).toMatchObject({
      status: 'BLOCKED', assignedWorkerId: 'worker-x', blockedResourceId: 'bench-box',
    });
    expect(h.state.getTask('task-rest')?.status).toBe('DONE');
    expect(h.state.getEpic('epic-held')?.status).toBe('ACTIVE');
    await flushActivityLog(h.state);
    const archivedIds = h.state.getActivityLog(200)
      .filter((e: ActivityEvent) => e.event === 'TASK_ARCHIVED')
      .map((e: ActivityEvent) => e.taskId);
    expect(archivedIds).toEqual([]);
  });

  it('archive_epic records the caller on each TASK_ARCHIVED and names it in #general', async () => {
    await archiveEpicTool(h.state).handler({ epicId: 'epic-plain', workerId: 'architect-c' }, h.state);
    await flushActivityLog(h.state);
    const archived = h.state.getActivityLog(200)
      .filter((e: ActivityEvent) => e.event === 'TASK_ARCHIVED' && e.taskId === 'task-done')
      .map((e: ActivityEvent) => e.workerId ?? null);
    const general = h.state.getChannels().find((c) => c.name === 'general');
    const lines = general && fs.existsSync(path.join(h.moePath, 'messages', `${general.id}.jsonl`))
      ? fs.readFileSync(path.join(h.moePath, 'messages', `${general.id}.jsonl`), 'utf8').split('\n').filter(Boolean)
        .map((l) => (JSON.parse(l) as { content: string }).content).filter((c) => c.includes('Task moved to'))
      : [];
    expect({ archived, lines }).toEqual({
      archived: ['architect-c'],
      lines: ['task-done: Task moved to ARCHIVED by architect-c'],
    });
  });
});
