import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { deleteTaskTool } from './deleteTask.js';
import { deleteEpicTool } from './deleteEpic.js';
import { currentAttempt } from '../state/attemptStore.js';
import type { TeamRole } from '../types/schema.js';

// task-7cef0861: delete_task and delete_epic gate in their handlers like
// set_task_status (task-629ddc99). TOOL_AUDIENCE only filters tools/list.
// A named workerId must resolve to architect or governor; an absent key is the
// human path. Adapted from the hunt repro zzHuntA_deleteRoleGate.test.ts.
describe('delete_task / delete_epic role gate (task-7cef0861)', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => h.cleanup());

  async function seat(id: string, role: TeamRole): Promise<void> {
    await h.state.createWorker({ id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1', currentTaskId: null, status: 'IDLE' });
    const team = Array.from(h.state.teams.values()).find((t) => t.role === role)
      ?? await h.state.createTeam({ name: `${role}s`, role });
    await h.state.addTeamMember(team.id, id);
  }

  const taskFile = (id: string) => path.join(h.moePath, 'tasks', `${id}.json`);
  const epicFile = (id: string) => path.join(h.moePath, 'epics', `${id}.json`);
  const delTask = (args: Record<string, unknown>) => deleteTaskTool(h.state).handler(args, h.state);
  const delEpic = (args: Record<string, unknown>) => deleteEpicTool(h.state).handler(args, h.state);

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-review', status: 'REVIEW', assignedWorkerId: null });
    h.createTask({
      id: 'task-peer', status: 'WORKING', assignedWorkerId: null,
      implementationPlan: [{ stepId: 'step-1', description: 'do it', status: 'IN_PROGRESS', affectedFiles: ['file.ts'] } as never],
    });
    await h.state.load();
    await seat('worker-1', 'worker');
    await seat('qa-1', 'qa');
    await seat('worker-peer', 'worker');
  });

  it('(r1) a qa seat deleting a live peer\'s WORKING row is refused; row, holder and open attempt are untouched', async () => {
    await claimNextTaskTool(h.state).handler({ statuses: ['WORKING'], taskId: 'task-peer', workerId: 'worker-peer' }, h.state);
    expect(currentAttempt(h.state, 'task-peer')?.phase).toBe('running');

    await expect(delTask({ taskId: 'task-peer', workerId: 'qa-1' })).rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });

    expect(h.state.getTask('task-peer')).toMatchObject({ status: 'WORKING', assignedWorkerId: 'worker-peer' });
    expect(fs.existsSync(taskFile('task-peer'))).toBe(true);
    expect(h.state.getWorker('worker-peer')).toMatchObject({ currentTaskId: 'task-peer' });
    expect(currentAttempt(h.state, 'task-peer')?.phase).toBe('running');
  });

  it('(r2) a worker seat deleting a REVIEW row is refused and the row stays', async () => {
    await expect(delTask({ taskId: 'task-review', workerId: 'worker-1' })).rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    expect(h.state.getTask('task-review')).toMatchObject({ status: 'REVIEW' });
    expect(fs.existsSync(taskFile('task-review'))).toBe(true);
  });

  it.each([[''], [null], [123], [{}]])('(r3) delete_task and delete_epic refuse workerId %j', async (workerId) => {
    await expect(delTask({ taskId: 'task-review', workerId })).rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    await expect(delEpic({ epicId: 'epic-1', cascadeDelete: true, workerId })).rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    expect(h.state.getTask('task-review')).not.toBeNull();
    expect(h.state.getEpic('epic-1')).not.toBeNull();
  });

  it.each([[false], [true]])('(r4) delete_epic from worker-1 with cascadeDelete=%s is refused by the role gate', async (cascadeDelete) => {
    await expect(delEpic({ epicId: 'epic-1', cascadeDelete, workerId: 'worker-1' })).rejects.toMatchObject({
      codeName: 'NOT_ALLOWED',
      message: expect.stringContaining('architect or governor role required'),
    });
    expect(h.state.getEpic('epic-1')).not.toBeNull();
    expect(fs.existsSync(epicFile('epic-1'))).toBe(true);
    expect(h.state.getTask('task-peer')).not.toBeNull();
    expect(h.state.getTask('task-review')).not.toBeNull();
  });

  it('(r5) the gate runs before the lookup: a missing id gets NOT_ALLOWED, not not-found', async () => {
    await expect(delTask({ taskId: 'task-missing', workerId: 'worker-1' })).rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    await expect(delEpic({ epicId: 'epic-missing', workerId: 'worker-1' })).rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
  });

  it('(a1) architect-1, governor-1, a governor-team member with a plain id and a workerId-less call still delete a task', async () => {
    await seat('plain-gov', 'governor');
    for (const [id, workerId] of [['a', 'architect-1'], ['b', 'governor-1'], ['c', 'plain-gov'], ['d', undefined]] as const) {
      h.createTask({ id: `task-del-${id}`, status: 'BACKLOG' });
      await h.state.load();
      const args = workerId === undefined ? { taskId: `task-del-${id}` } : { taskId: `task-del-${id}`, workerId };
      await expect(delTask(args)).resolves.toMatchObject({ success: true });
      expect(h.state.getTask(`task-del-${id}`)).toBeNull();
      expect(fs.existsSync(taskFile(`task-del-${id}`))).toBe(false);
    }
  });

  it.each([['architect-1'], ['governor-1'], [undefined]])('(a2) delete_epic with cascadeDelete still works for %s', async (workerId) => {
    const args = workerId === undefined ? { epicId: 'epic-1', cascadeDelete: true } : { epicId: 'epic-1', cascadeDelete: true, workerId };
    await expect(delEpic(args)).resolves.toMatchObject({ success: true, deletedTaskCount: 2 });
    expect(h.state.getEpic('epic-1')).toBeNull();
    expect(h.state.getTask('task-peer')).toBeNull();
    expect(h.state.getTask('task-review')).toBeNull();
  });
});
